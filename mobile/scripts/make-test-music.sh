#!/usr/bin/env bash
# A small tagged music library for the smoke test (needs ffmpeg):
#   bash mobile/scripts/make-test-music.sh /tmp/lokal-test-music
set -euo pipefail
out="${1:?usage: make-test-music.sh <folder>}"
mkdir -p "$out/Beyoncé/Lemonade" "$out/Кино/Группа крови" "$out/Daft Punk/Discovery" "$out/Misc"
cd "$out"
ffmpeg -loglevel error -y -f lavfi -i "color=c=orange:s=300x300" -frames:v 1 cover.jpg
tone() { echo "sine=frequency=$1:duration=$2"; }
tagged() { # file freq encoder-args title artist album track year genre [album_artist]
  ffmpeg -loglevel error -y -f lavfi -i "$(tone "$2" 12)" -i cover.jpg -map 0:a -map 1:v $3 \
    -metadata title="$4" -metadata artist="$5" -metadata album="$6" -metadata album_artist="${10:-$5}" \
    -metadata track="$7" -metadata date="$8" -metadata genre="$9" -disposition:v attached_pic "$1"
}
tagged "Beyoncé/Lemonade/01 Formation.mp3" 440 "-c:a libmp3lame -b:a 128k -id3v2_version 3" "Formation" "Beyoncé" "Lemonade" 1 2016 "R&B"
tagged "Beyoncé/Lemonade/02 Hold Up.mp3" 494 "-c:a libmp3lame -b:a 128k -id3v2_version 3" "Hold Up" "Beyoncé feat. Jack White" "Lemonade" 2 2016 "Pop" "Beyoncé"
tagged "Кино/Группа крови/01 Группа крови.flac" 523 "-c:a flac -c:v mjpeg" "Группа крови" "Кино" "Группа крови" 1 1988 "Rock"
tagged "Daft Punk/Discovery/01 One More Time.m4a" 587 "-c:a aac -b:a 128k -c:v mjpeg" "One More Time" "Daft Punk" "Discovery" 1 2001 "Electronic"
ffmpeg -loglevel error -y -f lavfi -i "$(tone 550 12)" -c:a libvorbis -metadata title="Aerodynamic" -metadata artist="Daft Punk" -metadata album="Discovery" -metadata track=2 -metadata date=2001 -metadata genre=Electronic "Daft Punk/Discovery/02 Aerodynamic.ogg"
ffmpeg -loglevel error -y -f lavfi -i "$(tone 660 12)" -c:a libopus -metadata title="Digital Love" -metadata artist="Daft Punk" -metadata album="Discovery" -metadata track=3 -metadata date=2001 -metadata genre=Electronic "Daft Punk/Discovery/03 Digital Love.opus"
printf '[00:01.00]Okay ladies\n[00:05.00]Now let us get in formation\n' > "Beyoncé/Lemonade/01 Formation.lrc"
# An MP3 with only an ID3v1 tag (Latin-1 text).
ffmpeg -loglevel error -y -f lavfi -i "$(tone 700 10)" -c:a libmp3lame -b:a 96k -id3v2_version 0 -write_xing 0 "Misc/v1only.mp3"
python3 - "Misc/v1only.mp3" <<'PY'
import sys
f = lambda s, n: s.encode('latin-1')[:n].ljust(n, b'\0')
with open(sys.argv[1], 'ab') as out:
    out.write(b'TAG' + f('Café Tacuba', 30) + f('Café Tacvba', 30) + f('Re', 30) + f('1994', 4) + f('', 28) + b'\0\x01\x0d')
PY
rm cover.jpg
echo "test library in $out"
