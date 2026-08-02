use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ringbuf::traits::{Consumer, Observer};

use super::audio::{resample_interleaved, AudioInput, AudioSource};
use super::{ErrorSink, EventSink, VoxCapabilities, VoxCaptureState, VoxEvent, VoxFinal};

const LEVEL_INTERVAL: Duration = Duration::from_millis(40);
const STOP_DRAIN_POLL: Duration = Duration::from_millis(5);
const STOP_DRAIN_GRACE: Duration = Duration::from_millis(150);
const MIN_SPEECH_MS: u64 = 100;
const MIN_PEAK_RMS: f32 = 0.01;
const MIN_OVERALL_RMS: f32 = 0.003;
// Streaming partials (KödWhisper Pro): re-decode the growing buffer on this
// cadence. Generous by design — each partial re-runs whisper over the whole
// utterance so far, which is why the feature is Pro- and hardware-gated in TS.
const PARTIAL_INTERVAL: Duration = Duration::from_millis(600);
// Don't bother decoding a buffer shorter than this (16 kHz mono samples ≈ 400 ms)
// — too little audio to produce a useful hypothesis.
const MIN_PARTIAL_SAMPLES: usize = 6_400;
static NEXT_UTTERANCE: AtomicU64 = AtomicU64::new(1);

// Options for a single decode. `initial_prompt` biases whisper toward the
// project vocabulary (KödWhisper Pro); None is the unbiased free-tier decode.
pub(crate) struct DecodeOptions<'a> {
    pub language: &'a str,
    pub initial_prompt: Option<&'a str>,
}

pub(crate) trait Transcriber: Send {
    fn transcribe(&mut self, pcm16k: &[f32], options: &DecodeOptions) -> Result<String, String>;
}

// Per-capture options threaded from `vox_start`. `streaming` turns on the
// re-decode partial loop; the engine stays tier-blind — TS decides when to set it.
pub(crate) struct StartOptions {
    pub language: Option<String>,
    pub initial_prompt: Option<String>,
    pub streaming: bool,
}

// LocalAgreement-2 stabilization: the committed text is the longest word-wise
// common prefix of the two most recent hypotheses. Pure and unit-tested — this
// is what keeps streaming partials from flicker-rewriting already-shown text.
pub(crate) fn local_agreement_prefix(prev: &[String], curr: &[String]) -> Vec<String> {
    prev.iter()
        .zip(curr.iter())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.clone())
        .collect()
}

pub(crate) trait TranscriberFactory: Send {
    fn backend(&self) -> &'static str;
    fn load(&mut self, model_path: &str) -> Result<Box<dyn Transcriber>, String>;
}

pub(crate) struct ActorHandle {
    controller: VoxController,
    thread: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub(crate) struct VoxController {
    commands: Sender<ActorCommand>,
}

pub(crate) type ActorReply<T> = Receiver<Result<T, String>>;

enum ActorCommand {
    Init {
        model_path: String,
        device_name: Option<String>,
        response: Sender<Result<VoxCapabilities, String>>,
    },
    Start {
        options: StartOptions,
        on_event: EventSink,
        response: Sender<Result<String, String>>,
    },
    Stop {
        response: Sender<Result<VoxFinal, String>>,
    },
    Cancel {
        response: Sender<Result<(), String>>,
    },
    Teardown {
        response: Sender<Result<(), String>>,
    },
    Shutdown,
}

struct Capture {
    utterance_id: String,
    language: String,
    // Vocabulary bias for both partial and final decodes (KödWhisper Pro).
    initial_prompt: Option<String>,
    // Streaming partial state. `streaming` off = classic transcribe-on-release.
    streaming: bool,
    // The committed (already-emitted) stabilized words — never shrinks, so the
    // UI's partial text never rewrites itself.
    stable_words: Vec<String>,
    // The previous hypothesis, for the LocalAgreement common-prefix check.
    prev_words: Vec<String>,
    on_event: EventSink,
    audio: UtteranceAudio,
}

struct UtteranceAudio {
    sample_rate: usize,
    channels: usize,
    partial_frame: Vec<f32>,
    mono: Vec<f32>,
    sum_squares: f64,
    peak_rms: f32,
}

impl UtteranceAudio {
    fn new(sample_rate: usize, channels: usize) -> Result<Self, String> {
        if sample_rate == 0 || channels == 0 {
            return Err("audio device returned an invalid stream format".to_string());
        }
        Ok(Self {
            sample_rate,
            channels,
            partial_frame: Vec::with_capacity(channels),
            mono: Vec::new(),
            sum_squares: 0.0,
            peak_rms: 0.0,
        })
    }

    fn push(&mut self, samples: &[f32]) -> f32 {
        let mut interval_squares = 0.0f64;
        let mut interval_frames = 0usize;
        for sample in samples {
            self.partial_frame.push(*sample);
            if self.partial_frame.len() != self.channels {
                continue;
            }
            let mono = self.partial_frame.iter().sum::<f32>() / self.channels as f32;
            self.partial_frame.clear();
            self.mono.push(mono);
            let square = f64::from(mono) * f64::from(mono);
            self.sum_squares += square;
            interval_squares += square;
            interval_frames += 1;
        }
        if interval_frames == 0 {
            return 0.0;
        }
        let rms = (interval_squares / interval_frames as f64).sqrt() as f32;
        self.peak_rms = self.peak_rms.max(rms);
        rms
    }

    fn duration_ms(&self) -> u64 {
        (self.mono.len() as u64 * 1000) / self.sample_rate as u64
    }

    fn has_speech(&self) -> bool {
        if self.duration_ms() < MIN_SPEECH_MS || self.mono.is_empty() {
            return false;
        }
        let overall_rms = (self.sum_squares / self.mono.len() as f64).sqrt() as f32;
        self.peak_rms >= MIN_PEAK_RMS && overall_rms >= MIN_OVERALL_RMS
    }

    fn into_pcm16k(self) -> Result<Vec<f32>, String> {
        resample_interleaved(&self.mono, 1, self.sample_rate)
    }

    // A 16 kHz snapshot of the audio captured so far, without consuming the
    // buffer — used for streaming partial re-decodes while capture continues.
    fn snapshot_pcm16k(&self) -> Result<Vec<f32>, String> {
        resample_interleaved(&self.mono, 1, self.sample_rate)
    }
}

struct Actor {
    factory: Box<dyn TranscriberFactory>,
    audio_source: Box<dyn AudioSource>,
    transcriber: Option<Box<dyn Transcriber>>,
    model_path: Option<String>,
    // The expert-picked input device (by name). None means "use the host
    // default." Changing it invalidates any already-open stream so the next
    // start() reopens against the newly selected device.
    preferred_device: Option<String>,
    input: Option<AudioInput>,
    capture: Option<Capture>,
    on_error: ErrorSink,
    audio_errors_tx: Sender<String>,
    audio_errors_rx: Receiver<String>,
}

impl ActorHandle {
    pub fn spawn(
        factory: Box<dyn TranscriberFactory>,
        audio_source: Box<dyn AudioSource>,
        on_error: ErrorSink,
    ) -> Result<Self, String> {
        let (commands_tx, commands_rx) = mpsc::channel();
        let (audio_errors_tx, audio_errors_rx) = mpsc::channel();
        let panic_sink = on_error.clone();
        let thread = thread::Builder::new()
            .name("kodade-vox".to_string())
            .spawn(move || {
                let mut actor = Actor {
                    factory,
                    audio_source,
                    transcriber: None,
                    model_path: None,
                    preferred_device: None,
                    input: None,
                    capture: None,
                    on_error,
                    audio_errors_tx,
                    audio_errors_rx,
                };
                if catch_unwind(AssertUnwindSafe(|| actor.run(commands_rx))).is_err() {
                    panic_sink("transcription actor panicked".to_string());
                }
            })
            .map_err(|e| format!("spawn transcription actor: {e}"))?;
        Ok(Self {
            controller: VoxController {
                commands: commands_tx,
            },
            thread: Some(thread),
        })
    }

    pub fn controller(&self) -> VoxController {
        self.controller.clone()
    }
}

impl VoxController {
    #[cfg(test)]
    pub fn init(&self, model_path: String) -> Result<VoxCapabilities, String> {
        receive_actor_response(self.enqueue_init(model_path, None)?)
    }

    #[cfg(test)]
    pub fn init_with_device(
        &self,
        model_path: String,
        device_name: Option<String>,
    ) -> Result<VoxCapabilities, String> {
        receive_actor_response(self.enqueue_init(model_path, device_name)?)
    }

    #[cfg(test)]
    pub fn start(&self, language: Option<String>, on_event: EventSink) -> Result<String, String> {
        self.start_with(
            StartOptions {
                language,
                initial_prompt: None,
                streaming: false,
            },
            on_event,
        )
    }

    #[cfg(test)]
    pub fn start_with(&self, options: StartOptions, on_event: EventSink) -> Result<String, String> {
        receive_actor_response(self.enqueue_start(options, on_event)?)
    }

    #[cfg(test)]
    pub fn stop(&self) -> Result<VoxFinal, String> {
        receive_actor_response(self.enqueue_stop()?)
    }

    #[cfg(test)]
    pub fn cancel(&self) -> Result<(), String> {
        receive_actor_response(self.enqueue_cancel()?)
    }

    #[cfg(test)]
    pub fn teardown(&self) -> Result<(), String> {
        receive_actor_response(self.enqueue_teardown()?)
    }

    pub(crate) fn enqueue_init(
        &self,
        model_path: String,
        device_name: Option<String>,
    ) -> Result<ActorReply<VoxCapabilities>, String> {
        let (response, receive) = mpsc::channel();
        self.send(ActorCommand::Init {
            model_path,
            device_name,
            response,
        })?;
        Ok(receive)
    }

    pub(crate) fn enqueue_start(
        &self,
        options: StartOptions,
        on_event: EventSink,
    ) -> Result<ActorReply<String>, String> {
        let (response, receive) = mpsc::channel();
        self.send(ActorCommand::Start {
            options,
            on_event,
            response,
        })?;
        Ok(receive)
    }

    pub(crate) fn enqueue_stop(&self) -> Result<ActorReply<VoxFinal>, String> {
        let (response, receive) = mpsc::channel();
        self.send(ActorCommand::Stop { response })?;
        Ok(receive)
    }

    pub(crate) fn enqueue_cancel(&self) -> Result<ActorReply<()>, String> {
        let (response, receive) = mpsc::channel();
        self.send(ActorCommand::Cancel { response })?;
        Ok(receive)
    }

    pub(crate) fn enqueue_teardown(&self) -> Result<ActorReply<()>, String> {
        let (response, receive) = mpsc::channel();
        self.send(ActorCommand::Teardown { response })?;
        Ok(receive)
    }

    fn send(&self, command: ActorCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "transcription actor is unavailable".to_string())
    }
}

impl Drop for ActorHandle {
    fn drop(&mut self) {
        let _ = self.controller.commands.send(ActorCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
fn receive_actor_response<T>(receive: Receiver<Result<T, String>>) -> Result<T, String> {
    receive
        .recv()
        .map_err(|_| "transcription actor stopped before responding".to_string())?
}

fn fresh_utterance_id() -> String {
    let sequence = NEXT_UTTERANCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("vox-{nanos:x}-{sequence:x}")
}

impl Actor {
    fn run(&mut self, commands: Receiver<ActorCommand>) {
        let mut next_level = Instant::now();
        let mut next_partial = Instant::now() + PARTIAL_INTERVAL;
        loop {
            self.handle_audio_errors();
            let level_due = Instant::now() >= next_level;
            let (_, emitted_level) = self.drain_audio(level_due);
            if emitted_level {
                next_level = Instant::now() + LEVEL_INTERVAL;
            }
            // Streaming partials: re-decode the growing buffer on its cadence.
            // Best-effort — a failed partial never disturbs the capture.
            if self.streaming_capture_active() && Instant::now() >= next_partial {
                self.maybe_emit_partial();
                next_partial = Instant::now() + PARTIAL_INTERVAL;
            }
            let wait = if self.capture.is_some() {
                let mut wait = next_level
                    .checked_duration_since(Instant::now())
                    .unwrap_or(Duration::ZERO)
                    .min(LEVEL_INTERVAL);
                if self.streaming_capture_active() {
                    wait = wait.min(
                        next_partial
                            .checked_duration_since(Instant::now())
                            .unwrap_or(Duration::ZERO),
                    );
                }
                wait
            } else {
                LEVEL_INTERVAL
            };
            match commands.recv_timeout(wait) {
                Ok(command) => {
                    if !self.handle_command(command) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    fn handle_command(&mut self, command: ActorCommand) -> bool {
        match command {
            ActorCommand::Init {
                model_path,
                device_name,
                response,
            } => {
                let _ = response.send(self.init(model_path, device_name));
            }
            ActorCommand::Start {
                options,
                on_event,
                response,
            } => {
                let _ = response.send(self.start(options, on_event));
            }
            ActorCommand::Stop { response } => {
                let _ = response.send(self.stop());
            }
            ActorCommand::Cancel { response } => {
                let _ = response.send(self.cancel());
            }
            ActorCommand::Teardown { response } => {
                self.teardown();
                let _ = response.send(Ok(()));
            }
            ActorCommand::Shutdown => return false,
        }
        true
    }

    fn init(
        &mut self,
        model_path: String,
        device_name: Option<String>,
    ) -> Result<VoxCapabilities, String> {
        if model_path.trim().is_empty() {
            return Err("model path is empty".to_string());
        }
        if self.capture.is_some() {
            return Err("cannot change the transcription model while capturing".to_string());
        }
        let device_name = device_name.filter(|value| !value.trim().is_empty());
        if self.preferred_device != device_name {
            self.preferred_device = device_name;
            // An already-open stream is bound to the previous device; drop it
            // so the next start() reopens against the newly selected one.
            self.input = None;
        }
        if self.model_path.as_deref() != Some(model_path.as_str()) || self.transcriber.is_none() {
            let replacement = self.factory.load(&model_path)?;
            self.transcriber = Some(replacement);
            self.model_path = Some(model_path.clone());
        }
        Ok(VoxCapabilities {
            device: self
                .preferred_device
                .clone()
                .or_else(|| self.audio_source.default_device_name()),
            backend: self.factory.backend().to_string(),
            model_path,
        })
    }

    fn start(&mut self, options: StartOptions, on_event: EventSink) -> Result<String, String> {
        if self.transcriber.is_none() {
            return Err("transcription model is not initialized".to_string());
        }
        if self.capture.is_some() {
            return Err("audio capture is already active".to_string());
        }

        if self.input.is_some() {
            self.drain_audio(false);
        } else {
            let audio_errors = self.audio_errors_tx.clone();
            let global_error = self.on_error.clone();
            let input = self.audio_source.open(
                Arc::new(move |message| {
                    global_error(message.clone());
                    let _ = audio_errors.send(message);
                }),
                self.preferred_device.as_deref(),
            )?;
            self.input = Some(input);
        }
        let input = self
            .input
            .as_ref()
            .ok_or_else(|| "microphone did not produce a capture stream".to_string())?;
        let audio = UtteranceAudio::new(input.sample_rate, input.channels)?;
        let utterance_id = fresh_utterance_id();
        self.capture = Some(Capture {
            utterance_id: utterance_id.clone(),
            language: options
                .language
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "en".to_string()),
            initial_prompt: options
                .initial_prompt
                .filter(|value| !value.trim().is_empty()),
            streaming: options.streaming,
            stable_words: Vec::new(),
            prev_words: Vec::new(),
            on_event: on_event.clone(),
            audio,
        });
        if let Err(error) = input.stream.play() {
            self.capture = None;
            return Err(error);
        }
        on_event(VoxEvent::State {
            state: VoxCaptureState::Capturing,
        });
        Ok(utterance_id)
    }

    fn stop(&mut self) -> Result<VoxFinal, String> {
        if self.capture.is_none() {
            return Err("audio capture is not active".to_string());
        }
        self.pause_input();
        self.drain_audio_until_quiet();
        let capture = self
            .capture
            .take()
            .ok_or_else(|| "audio capture is not active".to_string())?;
        (capture.on_event)(VoxEvent::State {
            state: VoxCaptureState::Transcribing,
        });
        let duration_ms = capture.audio.duration_ms();
        if !capture.audio.has_speech() {
            return Ok(VoxFinal {
                utterance_id: capture.utterance_id,
                text: String::new(),
                duration_ms,
            });
        }
        let initial_prompt = capture.initial_prompt.clone();
        let language = capture.language.clone();
        let pcm16k = capture.audio.into_pcm16k()?;
        let transcriber = self
            .transcriber
            .as_mut()
            .ok_or_else(|| "transcription model is not initialized".to_string())?;
        let options = DecodeOptions {
            language: &language,
            initial_prompt: initial_prompt.as_deref(),
        };
        let result = catch_unwind(AssertUnwindSafe(|| {
            transcriber.transcribe(&pcm16k, &options)
        }));
        let text = match result {
            Ok(Ok(text)) => text,
            Ok(Err(message)) => {
                self.report_inference_error(&capture.on_event, message.clone());
                return Err(message);
            }
            Err(_) => {
                let message = "transcription engine panicked".to_string();
                self.transcriber = None;
                self.model_path = None;
                self.report_inference_error(&capture.on_event, message.clone());
                return Err(message);
            }
        };
        Ok(VoxFinal {
            utterance_id: capture.utterance_id,
            text,
            duration_ms,
        })
    }

    fn cancel(&mut self) -> Result<(), String> {
        if self.capture.is_none() {
            return Err("audio capture is not active".to_string());
        }
        self.pause_input();
        self.capture = None;
        Ok(())
    }

    fn teardown(&mut self) {
        self.capture = None;
        self.input = None;
        self.transcriber = None;
        self.model_path = None;
        while self.audio_errors_rx.try_recv().is_ok() {}
    }

    fn drain_audio(&mut self, emit_level: bool) -> (usize, bool) {
        let Some(input) = self.input.as_mut() else {
            return (0, false);
        };
        let available = input.consumer.occupied_len();
        let mut samples = vec![0.0; available];
        let count = input.consumer.pop_slice(&mut samples);
        let Some(capture) = self.capture.as_mut() else {
            return (count, false);
        };
        let rms = capture.audio.push(&samples[..count]);
        if emit_level {
            (capture.on_event)(VoxEvent::Level { rms });
        }
        (count, emit_level)
    }

    fn streaming_capture_active(&self) -> bool {
        self.capture
            .as_ref()
            .is_some_and(|capture| capture.streaming)
    }

    // Re-decode the audio captured so far and emit a stabilized partial. The
    // committed prefix (LocalAgreement-2) only grows, so the UI never sees
    // already-shown words rewritten. Any failure is swallowed — partials are a
    // preview, and the authoritative decode still happens on stop().
    fn maybe_emit_partial(&mut self) {
        let Some(capture) = self.capture.as_ref() else {
            return;
        };
        if !capture.streaming {
            return;
        }
        let Ok(pcm) = capture.audio.snapshot_pcm16k() else {
            return;
        };
        if pcm.len() < MIN_PARTIAL_SAMPLES {
            return;
        }
        let language = capture.language.clone();
        let initial_prompt = capture.initial_prompt.clone();
        let Some(transcriber) = self.transcriber.as_mut() else {
            return;
        };
        let options = DecodeOptions {
            language: &language,
            initial_prompt: initial_prompt.as_deref(),
        };
        let decoded = catch_unwind(AssertUnwindSafe(|| transcriber.transcribe(&pcm, &options)));
        let text = match decoded {
            Ok(Ok(text)) => text,
            _ => return,
        };
        let current: Vec<String> = text.split_whitespace().map(str::to_string).collect();
        let Some(capture) = self.capture.as_mut() else {
            return;
        };
        let agreed = local_agreement_prefix(&capture.prev_words, &current);
        if agreed.len() > capture.stable_words.len() {
            capture.stable_words = agreed;
            (capture.on_event)(VoxEvent::Partial {
                text: capture.stable_words.join(" "),
            });
        }
        capture.prev_words = current;
    }

    fn pause_input(&self) {
        if let Some(input) = self.input.as_ref() {
            let _ = input.stream.pause();
        }
    }

    fn drain_audio_until_quiet(&mut self) {
        let deadline = Instant::now() + STOP_DRAIN_GRACE;
        let mut empty_polls = 0;
        loop {
            let (drained, _) = self.drain_audio(false);
            if drained == 0 {
                empty_polls += 1;
                if empty_polls >= 2 {
                    break;
                }
            } else {
                empty_polls = 0;
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(STOP_DRAIN_POLL);
        }
    }

    fn handle_audio_errors(&mut self) {
        while let Ok(message) = self.audio_errors_rx.try_recv() {
            if let Some(capture) = self.capture.take() {
                (capture.on_event)(VoxEvent::Error { message });
            }
            self.input = None;
        }
    }

    fn report_inference_error(&self, on_event: &EventSink, message: String) {
        on_event(VoxEvent::Error {
            message: message.clone(),
        });
        (self.on_error)(message);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use ringbuf::traits::Producer;
    use ringbuf::HeapProd;

    use super::super::audio::{audio_handoff, AudioInput, AudioStream};
    use super::super::{VoxCaptureState, VoxEvent};
    use super::*;

    #[derive(Default)]
    struct StreamState {
        plays: AtomicUsize,
        pauses: AtomicUsize,
        pause_errors: AtomicUsize,
    }

    struct FakeStream {
        state: Arc<StreamState>,
    }

    impl AudioStream for FakeStream {
        fn play(&self) -> Result<(), String> {
            self.state.plays.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn pause(&self) -> Result<(), String> {
            self.state.pauses.fetch_add(1, Ordering::SeqCst);
            if self.state.pause_errors.load(Ordering::SeqCst) > 0 {
                Err("pause is unsupported".to_string())
            } else {
                Ok(())
            }
        }
    }

    struct FakeAudioSource {
        samples: Vec<f32>,
        sample_rate: usize,
        channels: usize,
        stream_state: Arc<StreamState>,
        opened_devices: Arc<Mutex<Vec<Option<String>>>>,
    }

    impl AudioSource for FakeAudioSource {
        fn default_device_name(&self) -> Option<String> {
            Some("Synthetic microphone".to_string())
        }

        fn list_input_devices(&self) -> Vec<String> {
            vec![
                "Synthetic microphone".to_string(),
                "USB headset".to_string(),
            ]
        }

        fn open(
            &mut self,
            _on_error: ErrorSink,
            device_name: Option<&str>,
        ) -> Result<AudioInput, String> {
            self.opened_devices
                .lock()
                .unwrap()
                .push(device_name.map(str::to_string));
            let (mut producer, consumer) = audio_handoff(self.samples.len().max(1) + 1);
            assert_eq!(producer.push_slice(&self.samples), self.samples.len());
            Ok(AudioInput {
                consumer,
                sample_rate: self.sample_rate,
                channels: self.channels,
                stream: Box::new(FakeStream {
                    state: self.stream_state.clone(),
                }),
            })
        }
    }

    struct TailStream {
        producer: Mutex<Option<HeapProd<f32>>>,
        tail: Vec<f32>,
    }

    impl AudioStream for TailStream {
        fn play(&self) -> Result<(), String> {
            Ok(())
        }

        fn pause(&self) -> Result<(), String> {
            let Some(mut producer) = self.producer.lock().unwrap().take() else {
                return Ok(());
            };
            let tail = self.tail.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(1));
                assert_eq!(producer.push_slice(&tail), tail.len());
            });
            Ok(())
        }
    }

    struct TailAudioSource {
        tail: Vec<f32>,
        sample_rate: usize,
    }

    impl AudioSource for TailAudioSource {
        fn default_device_name(&self) -> Option<String> {
            Some("Synthetic microphone".to_string())
        }

        fn open(
            &mut self,
            _on_error: ErrorSink,
            _device_name: Option<&str>,
        ) -> Result<AudioInput, String> {
            let (producer, consumer) = audio_handoff(self.tail.len() + 1);
            Ok(AudioInput {
                consumer,
                sample_rate: self.sample_rate,
                channels: 1,
                stream: Box::new(TailStream {
                    producer: Mutex::new(Some(producer)),
                    tail: self.tail.clone(),
                }),
            })
        }
    }

    struct FakeTranscriber {
        calls: Arc<AtomicUsize>,
        languages: Arc<Mutex<Vec<String>>>,
        prompts: Arc<Mutex<Vec<Option<String>>>>,
        text: String,
    }

    impl Transcriber for FakeTranscriber {
        fn transcribe(
            &mut self,
            _pcm16k: &[f32],
            options: &DecodeOptions,
        ) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.languages
                .lock()
                .unwrap()
                .push(options.language.to_string());
            self.prompts
                .lock()
                .unwrap()
                .push(options.initial_prompt.map(str::to_string));
            Ok(self.text.clone())
        }
    }

    struct FakeFactory {
        calls: Arc<AtomicUsize>,
        languages: Arc<Mutex<Vec<String>>>,
        prompts: Arc<Mutex<Vec<Option<String>>>>,
        loaded_paths: Arc<Mutex<Vec<String>>>,
        text: String,
    }

    impl TranscriberFactory for FakeFactory {
        fn backend(&self) -> &'static str {
            "cpu"
        }

        fn load(&mut self, model_path: &str) -> Result<Box<dyn Transcriber>, String> {
            self.loaded_paths
                .lock()
                .unwrap()
                .push(model_path.to_string());
            Ok(Box::new(FakeTranscriber {
                calls: self.calls.clone(),
                languages: self.languages.clone(),
                prompts: self.prompts.clone(),
                text: self.text.clone(),
            }))
        }
    }

    struct ActorFixture {
        handle: ActorHandle,
        calls: Arc<AtomicUsize>,
        languages: Arc<Mutex<Vec<String>>>,
        prompts: Arc<Mutex<Vec<Option<String>>>>,
        loaded_paths: Arc<Mutex<Vec<String>>>,
        stream_state: Arc<StreamState>,
        opened_devices: Arc<Mutex<Vec<Option<String>>>>,
    }

    fn actor_with_samples(samples: Vec<f32>, text: &str) -> ActorFixture {
        let calls = Arc::new(AtomicUsize::new(0));
        let languages = Arc::new(Mutex::new(Vec::new()));
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let loaded_paths = Arc::new(Mutex::new(Vec::new()));
        let stream_state = Arc::new(StreamState::default());
        let opened_devices = Arc::new(Mutex::new(Vec::new()));
        let handle = ActorHandle::spawn(
            Box::new(FakeFactory {
                calls: calls.clone(),
                languages: languages.clone(),
                prompts: prompts.clone(),
                loaded_paths: loaded_paths.clone(),
                text: text.to_string(),
            }),
            Box::new(FakeAudioSource {
                samples,
                sample_rate: 48_000,
                channels: 2,
                stream_state: stream_state.clone(),
                opened_devices: opened_devices.clone(),
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
        ActorFixture {
            handle,
            calls,
            languages,
            prompts,
            loaded_paths,
            stream_state,
            opened_devices,
        }
    }

    #[test]
    fn actor_enforces_capture_state_transitions() {
        let ActorFixture { handle, .. } = actor_with_samples(Vec::new(), "unused");
        let controller = handle.controller();
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };

        assert!(controller.start(None, event_sink.clone()).is_err());
        let capabilities = controller.init("model.bin".to_string()).unwrap();
        assert_eq!(capabilities.device.as_deref(), Some("Synthetic microphone"));
        assert_eq!(capabilities.backend, "cpu");
        assert_eq!(capabilities.model_path, "model.bin");

        let first_id = controller.start(None, event_sink.clone()).unwrap();
        assert!(controller.start(None, event_sink.clone()).is_err());
        controller.cancel().unwrap();
        let second_id = controller.start(None, event_sink.clone()).unwrap();
        assert_ne!(first_id, second_id);
        controller.stop().unwrap();
        controller.teardown().unwrap();
        assert!(controller.start(None, event_sink).is_err());

        let events = events.lock().unwrap();
        assert!(events.contains(&VoxEvent::State {
            state: VoxCaptureState::Capturing
        }));
        assert!(events.contains(&VoxEvent::State {
            state: VoxCaptureState::Transcribing
        }));
    }

    #[test]
    fn init_selects_the_requested_input_device() {
        let ActorFixture {
            handle,
            opened_devices,
            ..
        } = actor_with_samples(Vec::new(), "unused");
        let controller = handle.controller();

        controller
            .init_with_device("model.bin".to_string(), Some("USB headset".to_string()))
            .unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();
        controller.stop().unwrap();

        assert_eq!(
            &*opened_devices.lock().unwrap(),
            &[Some("USB headset".to_string())]
        );
    }

    #[test]
    fn changing_the_preferred_device_reopens_the_audio_stream() {
        let ActorFixture {
            handle,
            opened_devices,
            ..
        } = actor_with_samples(Vec::new(), "unused");
        let controller = handle.controller();

        controller.init("model.bin".to_string()).unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();
        controller.cancel().unwrap();
        // Re-init with the same model but a different device: the cached
        // stream from the default device must not be reused.
        controller
            .init_with_device("model.bin".to_string(), Some("USB headset".to_string()))
            .unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();
        controller.stop().unwrap();

        assert_eq!(
            &*opened_devices.lock().unwrap(),
            &[None, Some("USB headset".to_string())]
        );
    }

    #[test]
    fn voiced_audio_is_transcribed_with_language_and_audio_duration() {
        let samples = vec![0.2; 48_000]; // 500 ms of 48 kHz stereo audio.
        let ActorFixture {
            handle,
            calls,
            languages,
            ..
        } = actor_with_samples(samples, "hello world");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();

        let utterance_id = controller
            .start(Some("fr".to_string()), Arc::new(|_| {}))
            .unwrap();
        let final_result = controller.stop().unwrap();

        assert_eq!(final_result.utterance_id, utterance_id);
        assert_eq!(final_result.text, "hello world");
        assert_eq!(final_result.duration_ms, 500);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(&*languages.lock().unwrap(), &["fr"]);
    }

    #[test]
    fn silent_audio_returns_empty_without_calling_transcriber() {
        let ActorFixture { handle, calls, .. } =
            actor_with_samples(vec![0.0; 48_000], "hallucination");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();

        let final_result = controller.stop().unwrap();

        assert_eq!(final_result.text, "");
        assert_eq!(final_result.duration_ms, 500);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reinitializing_with_a_different_path_replaces_the_model() {
        let ActorFixture {
            handle,
            loaded_paths,
            ..
        } = actor_with_samples(Vec::new(), "unused");
        let controller = handle.controller();

        controller.init("first.bin".to_string()).unwrap();
        controller.init("first.bin".to_string()).unwrap();
        controller.init("second.bin".to_string()).unwrap();

        assert_eq!(&*loaded_paths.lock().unwrap(), &["first.bin", "second.bin"]);
    }

    #[test]
    fn start_and_stop_keep_enqueue_order_when_stop_reply_waits_first() {
        let ActorFixture { handle, .. } = actor_with_samples(Vec::new(), "unused");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();

        let start_reply = controller
            .enqueue_start(
                StartOptions {
                    language: None,
                    initial_prompt: None,
                    streaming: false,
                },
                Arc::new(|_| {}),
            )
            .unwrap();
        let stop_reply = controller.enqueue_stop().unwrap();
        let final_result = receive_actor_response(stop_reply).unwrap();
        let utterance_id = receive_actor_response(start_reply).unwrap();

        assert_eq!(final_result.utterance_id, utterance_id);
    }

    #[test]
    fn stop_waits_for_tail_samples_before_finalizing() {
        let calls = Arc::new(AtomicUsize::new(0));
        let handle = ActorHandle::spawn(
            Box::new(FakeFactory {
                calls: calls.clone(),
                languages: Arc::new(Mutex::new(Vec::new())),
                prompts: Arc::new(Mutex::new(Vec::new())),
                loaded_paths: Arc::new(Mutex::new(Vec::new())),
                text: "complete phrase".to_string(),
            }),
            Box::new(TailAudioSource {
                tail: vec![0.2; 3_200],
                sample_rate: 16_000,
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();

        let final_result = controller.stop().unwrap();

        assert_eq!(final_result.duration_ms, 200);
        assert_eq!(final_result.text, "complete phrase");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn idle_capture_pauses_and_reuses_the_stream_on_restart() {
        let ActorFixture {
            handle,
            stream_state,
            ..
        } = actor_with_samples(Vec::new(), "unused");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();

        controller.start(None, Arc::new(|_| {})).unwrap();
        controller.cancel().unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();
        controller.stop().unwrap();

        assert_eq!(stream_state.plays.load(Ordering::SeqCst), 2);
        assert_eq!(stream_state.pauses.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn unsupported_stream_pause_falls_back_without_failing_stop() {
        let ActorFixture {
            handle,
            stream_state,
            ..
        } = actor_with_samples(Vec::new(), "unused");
        stream_state.pause_errors.store(1, Ordering::SeqCst);
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();
        controller.start(None, Arc::new(|_| {})).unwrap();

        let result = controller.stop();

        assert!(result.is_ok());
        assert_eq!(stream_state.pauses.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn queued_commands_do_not_starve_audio_level_drain() {
        let ActorFixture { handle, .. } = actor_with_samples(vec![0.2; 48_000], "unused");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let start_reply = controller
            .enqueue_start(
                StartOptions {
                    language: None,
                    initial_prompt: None,
                    streaming: false,
                },
                event_sink,
            )
            .unwrap();

        for index in 0..20_000 {
            let (response, _receive) = mpsc::channel();
            controller
                .send(ActorCommand::Init {
                    model_path: format!("queued-{index}.bin"),
                    device_name: None,
                    response,
                })
                .unwrap();
        }
        let (barrier, barrier_receive) = mpsc::channel();
        controller
            .send(ActorCommand::Init {
                model_path: "barrier.bin".to_string(),
                device_name: None,
                response: barrier,
            })
            .unwrap();
        receive_actor_response(start_reply).unwrap();
        let _ = receive_actor_response(barrier_receive);

        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, VoxEvent::Level { rms } if *rms > 0.0)),
            "audio should be drained while commands remain queued"
        );
        controller.cancel().unwrap();
    }

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn local_agreement_prefix_is_the_common_word_prefix() {
        // Growing hypotheses that agree on their prefix commit that prefix.
        assert_eq!(
            local_agreement_prefix(&words("add a focused"), &words("add a focused test")),
            words("add a focused")
        );
        // A diverging tail truncates the committed prefix at the disagreement.
        assert_eq!(
            local_agreement_prefix(&words("add a focused test"), &words("add a broad test")),
            words("add a")
        );
        // No agreement commits nothing (no premature/flickering text).
        assert!(
            local_agreement_prefix(&words("delete the file"), &words("open the file")).is_empty()
        );
        // Empty previous hypothesis commits nothing on the first pass.
        assert!(local_agreement_prefix(&[], &words("anything")).is_empty());
    }

    #[test]
    fn initial_prompt_is_threaded_to_the_final_decode() {
        let ActorFixture {
            handle, prompts, ..
        } = actor_with_samples(vec![0.2; 48_000], "biased output");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();

        controller
            .start_with(
                StartOptions {
                    language: None,
                    initial_prompt: Some("Technical terms: appStore, voxStart.".to_string()),
                    streaming: false,
                },
                Arc::new(|_| {}),
            )
            .unwrap();
        controller.stop().unwrap();

        assert_eq!(
            &*prompts.lock().unwrap(),
            &[Some("Technical terms: appStore, voxStart.".to_string())]
        );
    }

    #[test]
    fn streaming_capture_emits_a_stabilized_partial() {
        // Plenty of voiced audio so the partial re-decode has enough to work with.
        let ActorFixture { handle, .. } =
            actor_with_samples(vec![0.2; 192_000], "add a focused test");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };

        controller
            .start_with(
                StartOptions {
                    language: None,
                    initial_prompt: None,
                    streaming: true,
                },
                sink,
            )
            .unwrap();
        // Two partial intervals (600 ms each) so LocalAgreement can commit.
        thread::sleep(Duration::from_millis(1_500));
        let final_result = controller.stop().unwrap();

        let partials: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                VoxEvent::Partial { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(
            !partials.is_empty(),
            "a streaming capture should emit at least one partial"
        );
        // Committed partial text never rewrites: each is a prefix of the final.
        for partial in &partials {
            assert!(
                final_result.text.starts_with(partial.as_str()),
                "partial {partial:?} is not a prefix of final {:?}",
                final_result.text
            );
        }
    }

    #[test]
    fn non_streaming_capture_emits_no_partials() {
        let ActorFixture { handle, .. } =
            actor_with_samples(vec![0.2; 192_000], "add a focused test");
        let controller = handle.controller();
        controller.init("model.bin".to_string()).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };

        controller.start(None, sink).unwrap();
        thread::sleep(Duration::from_millis(1_500));
        controller.stop().unwrap();

        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, VoxEvent::Partial { .. })),
            "the free-tier transcribe-on-release path must not emit partials"
        );
    }
}
