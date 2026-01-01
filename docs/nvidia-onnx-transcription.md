# NVIDIA Parakeet/Canary ONNX transcription

Summarize can now run local transcription through NVIDIA's Parakeet-TDT 0.6B-v3 or Canary 1B-v2 ONNX exports by shelling out to a user-provided CLI. The default remains Whisper/whisper.cpp; ONNX only runs when explicitly selected.

## How to enable

1) Choose a CLI capable of running the ONNX models (e.g. `sherpa-onnx` or a custom wrapper) and make sure it emits the transcribed text on stdout. The CLI must accept a single WAV input path. **Summarize now downloads the Hugging Face model files automatically on first use** into the cache (see below), so your command template can reference the provided paths.
2) Set one (or both) command templates:

- `SUMMARIZE_ONNX_PARAKEET_CMD="sherpa-onnx ... --tokens {vocab} --offline-ctc-model {model} --input-wav {input}"`
- `SUMMARIZE_ONNX_CANARY_CMD="... {model_dir} ... {input}"`

Placeholders:

- `{input}` — audio path (added to the end if not present)
- `{model}` — downloaded `model.onnx` path
- `{vocab}` — downloaded `vocab.txt` path
- `{model_dir}` — parent directory containing the downloaded files

3) Pick the ONNX model via CLI or env:

- CLI: `--transcriber parakeet` or `--transcriber canary`
- Env: `SUMMARIZE_TRANSCRIBER=parakeet` (or `canary`)

For the Chrome extension, you can pick a permanent default under **Settings → Model → Advanced Overrides → Transcriber**. The selection is sent with every request. Make sure the daemon environment still has your ONNX CLI commands configured (env vars above) so the override can take effect. Alternatively, export the env vars before running `summarize daemon install --token <TOKEN>` so the daemon inherits your ONNX command templates and default transcriber.

### Cache + download details

- Artifacts are stored under `${SUMMARIZE_ONNX_CACHE_DIR || $XDG_CACHE_HOME || ~/.cache}/summarize/onnx/<model>/`.
- Set `SUMMARIZE_ONNX_MODEL_BASE_URL` to point at a mirror (defaults to the Hugging Face repo for the chosen model).
- The first run downloads `model.onnx` and `vocab.txt`; subsequent runs reuse cached files.

## Behavior

- Input audio is transcoded to 16kHz mono WAV via `ffmpeg` when available; otherwise the original file is passed to the CLI.
- Onnx errors (missing command, non-zero exit, empty output) fall back to the existing Whisper flow with a note recorded in the transcript metadata.
- Progress UI shows "ONNX (Parakeet/Canary)" while the external transcriber runs.

## Notes

- The ONNX inference binary itself is **not** bundled; users must install or provide it separately.
- This flow remains CPU-only and compatible with existing transcript providers.
