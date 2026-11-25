"""Qwen3-TTS worker for the walkthrough builder (Apple Silicon, mlx-audio). Run by build.mjs with the Python in the
venv that `build.mjs --setup-voice qwen` made; not meant to be run by hand.

Voice:     python voice_qwen.py --model M --revision R --out-dir DIR --ref-audio WAV --ref-text-file JSON < jobs.json
           jobs.json: [{"text": "...", "file": "01-0123456789.mp4"}, ...]. Each clip is cloned from the reference
           voice, written to a temporary file in DIR and renamed into place, so a clip exists only when complete.
           One JSON line per clip on stdout ({"file", "audio_s"}); everything else goes to stderr. Exit 0 only when
           every clip was written. The builder runs this inside macOS's sandbox with all network denied.
Download:  python voice_qwen.py --download --model M --revision R [--offline]
           (setup only: fetches the weights at R; with --offline, only checks they are all already here)
"""
import argparse, json, os, re, subprocess, sys, tempfile
from pathlib import Path

SAFE_NAME = re.compile(r"^\d{2,3}-[0-9a-f]{10}\.mp4$")


def model_dir(model, revision, offline):
    from huggingface_hub import snapshot_download
    return snapshot_download(model, revision=revision, local_files_only=offline)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--revision", required=True)
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--out-dir")
    ap.add_argument("--ref-audio")
    ap.add_argument("--ref-text-file")
    a = ap.parse_args()

    results = sys.stdout
    sys.stdout = sys.stderr   # libraries print progress; keep stdout for one result line per clip

    if a.download:
        print(f"{'found' if a.offline else 'downloaded to'} {model_dir(a.model, a.revision, offline=a.offline)}", file=results, flush=True)
        return

    for f in ("out_dir", "ref_audio", "ref_text_file"):
        if not getattr(a, f):
            sys.exit(f"--{f.replace('_', '-')} is required")
    jobs = json.load(sys.stdin)
    if not isinstance(jobs, list) or not all(isinstance(j, dict) and isinstance(j.get("text"), str)
                                             and j["text"].strip() and SAFE_NAME.match(str(j.get("file", "")))
                                             for j in jobs):
        sys.exit("jobs must be a list of {text, file} with file names like 01-0123456789.mp4")
    ref_text = json.loads(Path(a.ref_text_file).read_text())["ref_text"]
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    import mlx.core as mx
    import numpy as np
    from mlx_audio.audio_io import write as audio_write
    from mlx_audio.tts.utils import load_model

    model = load_model(model_dir(a.model, a.revision, offline=True))
    for j in jobs:
        mx.random.seed(0)   # the same text gives the same take
        chunks, sr = [], model.sample_rate
        for r in model.generate(text=j["text"], ref_audio=a.ref_audio, ref_text=ref_text, lang_code="english"):
            chunks.append(np.asarray(r.audio).reshape(-1))
            sr = getattr(r, "sample_rate", None) or sr
        audio = np.concatenate(chunks) if chunks else np.zeros(0)
        if len(audio) < sr // 2:
            sys.exit(f"{j['file']}: the model returned no audio")
        with tempfile.TemporaryDirectory(dir=out, prefix=".voicing-") as tmp:   # same volume: the rename is atomic
            wav, mp4 = Path(tmp) / "clip.wav", Path(tmp) / "clip.mp4"
            audio_write(str(wav), audio, sr, format="wav")
            subprocess.run(["afconvert", "-f", "mp4f", "-d", "aac", str(wav), str(mp4)], check=True,
                           stdout=subprocess.DEVNULL)
            os.replace(mp4, out / j["file"])
        print(json.dumps({"file": j["file"], "audio_s": round(len(audio) / sr, 1)}), file=results, flush=True)


if __name__ == "__main__":
    main()
