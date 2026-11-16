import { Wave } from '@foobar404/wave';

import { Visualizer } from './visualizer';

import type { VisualizerPluginConfig } from '../index';

class WaveVisualizer extends Visualizer {
  private readonly visualizer: Wave;

  constructor(
    audioContext: AudioContext,
    audioSource: MediaElementAudioSourceNode,
    canvas: HTMLCanvasElement,
    audioNode: GainNode,
    _stream: MediaStream | undefined,
    config: VisualizerPluginConfig,
  ) {
    super(audioSource, audioNode);

    // Feed Wave from the (latency-delayed) audioNode via an AnalyserNode.
    // Passing an AnalyserNode also keeps Wave from connecting anything
    // to audioContext.destination.
    const analyser = audioContext.createAnalyser();
    audioNode.connect(analyser);
    this.visualizer = new Wave(analyser, canvas);
    for (const animation of config.wave.animations) {
      const TargetVisualizer =
        this.visualizer.animations[
          animation.type as keyof typeof this.visualizer.animations
        ];

      this.visualizer.addAnimation(
        new TargetVisualizer(animation.config as never), // Magic of Typescript
      );
    }
  }

  resize(_: number, __: number) {}

  destroy() {
    this.visualizer.clearAnimations();
    try {
      this.audioNode.disconnect();
    } catch {}
  }
}

export default WaveVisualizer;
