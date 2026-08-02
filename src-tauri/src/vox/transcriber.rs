use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::actor::{DecodeOptions, Transcriber, TranscriberFactory};

pub(crate) struct WhisperTranscriber {
    context: WhisperContext,
}

#[derive(Default)]
pub(crate) struct WhisperFactory;

impl TranscriberFactory for WhisperFactory {
    fn backend(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "metal"
        } else {
            "cpu"
        }
    }

    fn load(&mut self, model_path: &str) -> Result<Box<dyn Transcriber>, String> {
        let context =
            WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
                .map_err(|e| format!("load Whisper model at {model_path}: {e}"))?;
        Ok(Box::new(WhisperTranscriber { context }))
    }
}

impl Transcriber for WhisperTranscriber {
    fn transcribe(&mut self, pcm16k: &[f32], options: &DecodeOptions) -> Result<String, String> {
        let mut state = self
            .context
            .create_state()
            .map_err(|e| format!("create Whisper inference state: {e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(options.language));
        // Vocabulary bias (KödWhisper Pro): the project's identifiers as leading
        // context so whisper favors them over their spoken homophones.
        if let Some(prompt) = options.initial_prompt {
            params.set_initial_prompt(prompt);
        }
        params.set_translate(false);
        params.set_no_timestamps(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        state
            .full(params, pcm16k)
            .map_err(|e| format!("run Whisper inference: {e}"))?;
        let text = state
            .as_iter()
            .map(|segment| segment.to_string())
            .collect::<String>();
        Ok(text.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::*;

    #[test]
    #[ignore = "requires KODADE_WHISPER_MODEL pointing to a ggml model; run with: KODADE_WHISPER_MODEL=/path/model.bin cargo test real_whisper_accepts_pcm -- --ignored --nocapture"]
    fn real_whisper_accepts_pcm() {
        let model = env::var("KODADE_WHISPER_MODEL").expect("set KODADE_WHISPER_MODEL");
        let mut factory = WhisperFactory;
        let mut transcriber = factory.load(&model).unwrap();
        let pcm = vec![0.01; 16_000];
        transcriber
            .transcribe(
                &pcm,
                &DecodeOptions {
                    language: "en",
                    initial_prompt: None,
                },
            )
            .unwrap();
    }
}
