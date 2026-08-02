use ringbuf::{traits::Split, HeapCons, HeapProd, HeapRb};
use rubato::{FftFixedIn, Resampler};

use super::ErrorSink;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use ringbuf::traits::Producer;

pub(crate) const TARGET_SAMPLE_RATE: usize = 16_000;

// Create the single-producer/single-consumer handoff used by the device callback.
pub(crate) fn audio_handoff(capacity: usize) -> (HeapProd<f32>, HeapCons<f32>) {
    HeapRb::new(capacity).split()
}

pub(crate) trait AudioStream {
    fn play(&self) -> Result<(), String>;
    fn pause(&self) -> Result<(), String>;
}

impl AudioStream for cpal::Stream {
    fn play(&self) -> Result<(), String> {
        StreamTrait::play(self).map_err(|e| format!("start microphone capture: {e}"))
    }

    fn pause(&self) -> Result<(), String> {
        StreamTrait::pause(self).map_err(|e| format!("pause microphone capture: {e}"))
    }
}

pub(crate) struct AudioInput {
    pub consumer: HeapCons<f32>,
    pub sample_rate: usize,
    pub channels: usize,
    pub stream: Box<dyn AudioStream>,
}

pub(crate) trait AudioSource: Send {
    fn default_device_name(&self) -> Option<String>;
    // Every input device name the host currently exposes, for the expert
    // device picker. Default implementation is empty so test fakes don't need
    // to implement device enumeration.
    fn list_input_devices(&self) -> Vec<String> {
        Vec::new()
    }
    // `device_name` requests a specific input device by name (from
    // list_input_devices); None or a name that no longer exists falls back to
    // the host default rather than failing the capture.
    fn open(
        &mut self,
        on_error: ErrorSink,
        device_name: Option<&str>,
    ) -> Result<AudioInput, String>;
}

#[derive(Default)]
pub(crate) struct CpalAudioSource;

impl AudioSource for CpalAudioSource {
    fn default_device_name(&self) -> Option<String> {
        cpal::default_host()
            .default_input_device()
            .and_then(|device| device.name().ok())
    }

    fn list_input_devices(&self) -> Vec<String> {
        cpal::default_host()
            .input_devices()
            .map(|devices| devices.filter_map(|device| device.name().ok()).collect())
            .unwrap_or_default()
    }

    fn open(
        &mut self,
        on_error: ErrorSink,
        device_name: Option<&str>,
    ) -> Result<AudioInput, String> {
        let host = cpal::default_host();
        let device = device_name
            .and_then(|name| {
                host.input_devices().ok().and_then(|mut devices| {
                    devices.find(|candidate| candidate.name().is_ok_and(|n| n == name))
                })
            })
            .or_else(|| host.default_input_device())
            .ok_or_else(|| "no default microphone is available".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("read default microphone format: {e}"))?;
        let sample_rate = supported.sample_rate().0 as usize;
        let channels = supported.channels() as usize;
        let capacity = sample_rate
            .checked_mul(channels)
            .and_then(|value| value.checked_mul(2))
            .ok_or_else(|| "microphone format exceeds capture buffer limits".to_string())?;
        let (producer, consumer) = audio_handoff(capacity.max(1));
        let sample_format = supported.sample_format();
        let config = supported.into();
        let stream = match sample_format {
            SampleFormat::I8 => build_input_stream::<i8>(&device, &config, producer, on_error),
            SampleFormat::I16 => build_input_stream::<i16>(&device, &config, producer, on_error),
            SampleFormat::I24 => {
                build_input_stream::<cpal::I24>(&device, &config, producer, on_error)
            }
            SampleFormat::I32 => build_input_stream::<i32>(&device, &config, producer, on_error),
            SampleFormat::I64 => build_input_stream::<i64>(&device, &config, producer, on_error),
            SampleFormat::U8 => build_input_stream::<u8>(&device, &config, producer, on_error),
            SampleFormat::U16 => build_input_stream::<u16>(&device, &config, producer, on_error),
            SampleFormat::U32 => build_input_stream::<u32>(&device, &config, producer, on_error),
            SampleFormat::U64 => build_input_stream::<u64>(&device, &config, producer, on_error),
            SampleFormat::F32 => build_input_stream::<f32>(&device, &config, producer, on_error),
            SampleFormat::F64 => build_input_stream::<f64>(&device, &config, producer, on_error),
            format => Err(format!("microphone sample format {format} is unsupported")),
        }?;
        Ok(AudioInput {
            consumer,
            sample_rate,
            channels,
            stream: Box::new(stream),
        })
    }
}

// The realtime callback only converts one scalar and attempts one lock-free
// push per sample. Overflow is dropped instead of blocking the audio device.
fn build_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut producer: HeapProd<f32>,
    on_error: ErrorSink,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |samples: &[T], _| {
                for sample in samples {
                    let _ = producer.try_push(f32::from_sample(*sample));
                }
            },
            move |error| on_error(format!("microphone stream error: {error}")),
            None,
        )
        .map_err(|e| format!("open microphone: {e}"))
}

// Convert device-native interleaved audio to Whisper's 16 kHz mono format.
pub(crate) fn resample_interleaved(
    samples: &[f32],
    channels: usize,
    sample_rate: usize,
) -> Result<Vec<f32>, String> {
    if channels == 0 || sample_rate == 0 {
        return Err("audio format has a zero channel count or sample rate".to_string());
    }
    if !samples.len().is_multiple_of(channels) {
        return Err("interleaved audio ended with an incomplete frame".to_string());
    }

    let mono: Vec<f32> = samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    if sample_rate == TARGET_SAMPLE_RATE || mono.is_empty() {
        return Ok(mono);
    }

    let mut resampler = FftFixedIn::<f32>::new(sample_rate, TARGET_SAMPLE_RATE, 1024, 2, 1)
        .map_err(|e| format!("create audio resampler: {e}"))?;
    let expected_frames =
        ((mono.len() as u128 * TARGET_SAMPLE_RATE as u128) / sample_rate as u128) as usize;
    let delay = resampler.output_delay();
    let mut output = Vec::with_capacity(expected_frames + delay + 1024);
    let mut remaining = mono.as_slice();

    while remaining.len() >= resampler.input_frames_next() {
        let consumed = resampler.input_frames_next();
        let chunk = resampler
            .process(&[remaining], None)
            .map_err(|e| format!("resample audio: {e}"))?;
        output.extend_from_slice(&chunk[0]);
        remaining = &remaining[consumed..];
    }
    if !remaining.is_empty() {
        let chunk = resampler
            .process_partial(Some(&[remaining]), None)
            .map_err(|e| format!("finish resampling audio: {e}"))?;
        output.extend_from_slice(&chunk[0]);
    }

    // FFT resampling delays the signal. Push zero frames until the complete
    // utterance is available, then remove that leading delay and padded tail.
    for _ in 0..2 {
        if output.len() >= delay + expected_frames {
            break;
        }
        let no_input: Option<&[&[f32]]> = None;
        let chunk = resampler
            .process_partial(no_input, None)
            .map_err(|e| format!("flush resampled audio: {e}"))?;
        output.extend_from_slice(&chunk[0]);
    }
    if output.len() < delay + expected_frames {
        return Err("audio resampler produced a truncated utterance".to_string());
    }

    Ok(output[delay..delay + expected_frames].to_vec())
}

#[cfg(test)]
mod tests {
    use std::f32::consts::TAU;

    use ringbuf::traits::{Consumer, Producer};

    use super::*;

    #[test]
    fn stereo_48khz_sine_becomes_mono_16khz_with_frequency_preserved() {
        let mut stereo = Vec::with_capacity(48_000 * 2);
        for frame in 0..48_000 {
            let sample = (TAU * 440.0 * frame as f32 / 48_000.0).sin() * 0.5;
            stereo.extend_from_slice(&[sample, sample]);
        }

        let mono = resample_interleaved(&stereo, 2, 48_000).unwrap();

        assert!((15_998..=16_002).contains(&mono.len()));
        let positive_crossings = mono
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        assert!((439..=441).contains(&positive_crossings));
    }

    #[test]
    fn ring_handoff_preserves_samples_and_drops_when_full() {
        let (mut producer, mut consumer) = audio_handoff(3);

        assert_eq!(producer.push_slice(&[0.25, -0.5, 0.75, 1.0]), 3);
        let mut received = [0.0; 4];
        let count = consumer.pop_slice(&mut received);

        assert_eq!(count, 3);
        assert_eq!(&received[..count], &[0.25, -0.5, 0.75]);
    }

    #[test]
    #[ignore = "requires audio hardware and microphone permission; run with: cargo test real_microphone_produces_samples -- --ignored --nocapture"]
    fn real_microphone_produces_samples() {
        use std::thread;
        use std::time::Duration;

        use ringbuf::traits::Observer;

        let mut source = CpalAudioSource;
        let input = source
            .open(std::sync::Arc::new(|message| panic!("{message}")), None)
            .unwrap();
        thread::sleep(Duration::from_millis(250));
        assert!(input.consumer.occupied_len() > 0);
    }
}
