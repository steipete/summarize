const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;

export class BrowserPcmAccumulator {
  private output: Float32Array;
  private writtenFrames = 0;

  constructor(
    durationSeconds: number,
    private readonly targetSampleRate: number,
    private readonly maxBytes: number,
    private readonly startTimestamp = 0,
  ) {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new Error("Decoded audio has an invalid duration.");
    }
    const estimatedFrames = Math.max(1, Math.ceil(durationSeconds * targetSampleRate));
    this.assertCapacity(estimatedFrames);
    this.output = new Float32Array(estimatedFrames);
  }

  add({
    duration,
    interleaved,
    numberOfChannels,
    numberOfFrames,
    sampleRate,
    timestamp,
  }: {
    duration: number;
    interleaved: Float32Array;
    numberOfChannels: number;
    numberOfFrames: number;
    sampleRate: number;
    timestamp: number;
  }): void {
    if (numberOfChannels <= 0) throw new Error("Decoded audio has no channels.");
    if (numberOfFrames <= 0) return;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("Decoded audio has an invalid sample rate.");
    }
    if (!Number.isFinite(timestamp)) throw new Error("Decoded audio has an invalid timestamp.");

    const effectiveDuration =
      Number.isFinite(duration) && duration > 0 ? duration : numberOfFrames / sampleRate;
    const relativeTimestamp = timestamp - this.startTimestamp;
    const outputStart = Math.max(0, Math.floor(relativeTimestamp * this.targetSampleRate));
    const outputEnd = Math.max(
      outputStart,
      Math.ceil((relativeTimestamp + effectiveDuration) * this.targetSampleRate),
    );
    if (outputEnd === 0) return;
    this.ensureCapacity(outputEnd);

    for (let outputFrame = outputStart; outputFrame < outputEnd; outputFrame += 1) {
      const sourcePosition = (outputFrame / this.targetSampleRate - relativeTimestamp) * sampleRate;
      const lowerFrame = Math.floor(sourcePosition);
      const upperFrame = Math.ceil(sourcePosition);
      const fraction = sourcePosition - lowerFrame;
      const lower = readMonoFrame(interleaved, lowerFrame, numberOfFrames, numberOfChannels);
      const upper = readMonoFrame(interleaved, upperFrame, numberOfFrames, numberOfChannels);
      this.output[outputFrame] =
        (this.output[outputFrame] ?? 0) + lower + fraction * (upper - lower);
    }
    this.writtenFrames = Math.max(this.writtenFrames, outputEnd);
  }

  finish(): Float32Array {
    if (this.writtenFrames === 0) return new Float32Array();
    return this.writtenFrames === this.output.length
      ? this.output
      : this.output.slice(0, this.writtenFrames);
  }

  private ensureCapacity(requiredFrames: number): void {
    if (requiredFrames <= this.output.length) return;
    this.assertCapacity(requiredFrames);
    const maxFrames = Math.floor(this.maxBytes / FLOAT32_BYTES);
    const grownFrames = Math.min(
      maxFrames,
      Math.max(requiredFrames, Math.ceil(this.output.length * 1.5)),
    );
    const grown = new Float32Array(grownFrames);
    grown.set(this.output);
    this.output = grown;
  }

  private assertCapacity(frames: number): void {
    if (frames > Math.floor(this.maxBytes / FLOAT32_BYTES)) {
      throw new Error("Decoded audio is too long for in-browser transcription.");
    }
  }
}

function readMonoFrame(
  interleaved: Float32Array,
  frame: number,
  numberOfFrames: number,
  numberOfChannels: number,
): number {
  if (frame < 0 || frame >= numberOfFrames) return 0;
  const offset = frame * numberOfChannels;
  if (numberOfChannels === 1) return interleaved[offset] ?? 0;
  if (numberOfChannels === 2) {
    return ((interleaved[offset] ?? 0) + (interleaved[offset + 1] ?? 0)) / 2;
  }
  let sum = 0;
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    sum += interleaved[offset + channel] ?? 0;
  }
  return sum / numberOfChannels;
}
