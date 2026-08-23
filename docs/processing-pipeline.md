# Processing pipeline

The processor creates lossless intermediate WAV files and performs the final
lossy encode only after all editing and mastering stages.

1. **Probe and decode:** validate AIFF with FFprobe and decode the first audio
   stream to mono 48 kHz 24-bit PCM.
2. **Noise analysis:** find low-level intervals with `silencedetect`, measure up
   to five of the longest with `astats`, and derive a bounded silence threshold.
3. **Repair and denoise:** apply a high-pass filter, `adeclick`, and `afftdn`.
4. **Handling-noise editing:** use FFmpeg `astats` and `aspectralstats` to find
   0.4–1.5 second broadband bursts, then use the pretrained Silero VAD model from
   `avr-vad` to reject anything overlapping speech. A burst is deleted only when
   it has quiet boundaries, no detected speech, and exceeds the configured
   confidence threshold. Edits use short equal-power crossfades; ambiguous
   candidates remain and appear in the report.
5. **Pacing and dynamics:** shorten qualifying silence to 400 ms, adapt gradual
   level differences with `dynaudnorm`, and apply moderate compression.
6. **Master:** measure and apply two-pass `loudnorm` targeting -16 LUFS, 7 LU
   loudness range, and -1.5 dBTP.
7. **Encode and verify:** create a mono 64 kbps MP3, write ID3v2.3 metadata, then
   independently verify technical properties and tags.

## Handling-noise limitations

The current detector intentionally favors false negatives over speech damage.
Broadband fricatives and plosives can resemble static, so candidates without
quiet boundaries or with Silero-detected speech are reported rather than
removed. Representative real church recordings should be added as private
evaluation fixtures before thresholds are made more aggressive or an AudioSet
classifier is introduced.
