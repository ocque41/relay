#!/usr/bin/env bash
# Re-encode the captured tmp/relay-pov/frames/ into the macOS-clean MP4
# (no audio track, libx264 main@4.0 CRF 14) and the ProRes 422 HQ master.
# The web-distributable variant is produced inline by render-relay-pov.mjs.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
FRAMES=tmp/relay-pov/frames
OUT=tmp/relay-pov
PADW=$(ls "$FRAMES" | head -1 | grep -oE '[0-9]+' | awk '{print length}')

echo "[encode] padw=$PADW frames=$(ls $FRAMES | wc -l | tr -d ' ')"

# B) macOS-clean H.264, no audio (QuickTime opens cleanly).
ffmpeg -y -framerate 30 -i "$FRAMES/f_%0${PADW}d.png" \
  -c:v libx264 -preset slow -crf 14 -profile:v main -level 4.0 \
  -pix_fmt yuv420p -aspect 16:9 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -movflags +faststart \
  -metadata title="Relay POV Demo" \
  "$OUT/relay-pov-quicktime.mp4"

# C) ProRes 422 HQ master.
ffmpeg -y -framerate 30 -i "$FRAMES/f_%0${PADW}d.png" \
  -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -vendor apl0 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  "$OUT/relay-pov-master.mov"

# D) Music-on web variant (only if the source web variant + a music track exist).
#    Mirrors the add-music-tech-house skill: stream-copy video, replace audio
#    with looped music, fade in 0.8 s, fade out 3 s, normalize to -16 LUFS.
WEB_IN="$OUT/relay-pov-1080p30.mp4"
MUSIC=$(ls assets/video/music/tech-house/*.mp3 2>/dev/null | head -1 || true)
if [[ -f "$WEB_IN" && -n "$MUSIC" ]]; then
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WEB_IN")
  FADE_OUT_START=$(awk "BEGIN { printf \"%.2f\", $DUR - 3.0 }")
  ffmpeg -y -i "$WEB_IN" \
    -stream_loop -1 -i "$MUSIC" \
    -map 0:v -map 1:a \
    -c:v copy \
    -c:a aac -b:a 192k -ac 2 -ar 48000 \
    -af "afade=t=in:st=0:d=0.8,afade=t=out:st=${FADE_OUT_START}:d=3,loudnorm=I=-16:LRA=11:TP=-1.5" \
    -shortest \
    -movflags +faststart \
    -metadata title="Relay POV" \
    "$OUT/relay-pov-1080p30-with-music.mp4"
else
  echo "[encode] skipping music variant (need both $WEB_IN and assets/video/music/tech-house/*.mp3)"
fi

# Strip macOS provenance/quarantine xattrs.
xattr -c "$OUT"/relay-pov-*.mp4 "$OUT"/relay-pov-*.mov 2>/dev/null || true

echo "[encode] done:"
ls -lh "$OUT"/relay-pov-*.mp4 "$OUT"/relay-pov-*.mov
