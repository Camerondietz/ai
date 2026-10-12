import type { NetLogEntry, NetPolicy } from '../lib/netPolicy';

export type LocalDevice = 'auto' | 'webgpu' | 'wasm';

export interface WorkerConfig {
  /** Absolute URL of the self-hosted ONNX Runtime files (".../ort/") */
  ortBase: string;
  allowRemoteModels: boolean;
  /** Absolute URL for self-hosted models (".../models/") */
  localModelPath: string;
  /** Hugging Face endpoint with trailing slash */
  remoteHost: string;
  policy: NetPolicy;
  appOrigin: string;
}

export interface LoadSpec {
  task: string;
  model: string;
  device: LocalDevice;
  dtype?: string;
}

export interface ProgressEvent {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export type WorkerRequest =
  | { type: 'init'; id: number; config: WorkerConfig }
  | { type: 'load'; id: number; spec: LoadSpec }
  | { type: 'run'; id: number; spec: LoadSpec; input: unknown; options?: Record<string, unknown> }
  | { type: 'tokenize'; id: number; model: string; text: string }
  | { type: 'interrupt'; id: number }
  | { type: 'unload'; id: number; key?: string };

export type WorkerResponse =
  | { type: 'progress'; id: number; event: ProgressEvent }
  | { type: 'token'; id: number; text: string }
  | { type: 'result'; id: number; data: unknown; device?: string; ms?: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'net'; entry: Omit<NetLogEntry, 'id'> };

export function pipelineKey(spec: LoadSpec): string {
  return `${spec.task}|${spec.model}|${spec.device}|${spec.dtype ?? 'default'}`;
}

/** Tasks the Local Lab exposes, with a known-good default model for each. */
export interface TaskInfo {
  task: string;
  label: string;
  input: 'text' | 'chat' | 'text-labels' | 'qa' | 'image' | 'audio' | 'text-pair';
  defaultModel: string;
  hint: string;
}

export const LOCAL_TASKS: TaskInfo[] = [
  { task: 'text-generation', label: 'Chat / text generation', input: 'chat', defaultModel: 'onnx-community/Qwen3-0.6B-ONNX', hint: 'Small instruction-tuned LLM. Use WebGPU for usable speed.' },
  { task: 'feature-extraction', label: 'Embeddings', input: 'text', defaultModel: 'onnx-community/all-MiniLM-L6-v2-ONNX', hint: 'Sentence embeddings (one input per line). Mean pooling + normalization.' },
  { task: 'text-classification', label: 'Text classification', input: 'text', defaultModel: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', hint: 'Sentiment / labels from a fine-tuned classifier.' },
  { task: 'zero-shot-classification', label: 'Zero-shot classification', input: 'text-labels', defaultModel: 'Xenova/nli-deberta-v3-xsmall', hint: 'Classify text into labels you provide, without fine-tuning.' },
  { task: 'token-classification', label: 'Named entities (NER)', input: 'text', defaultModel: 'Xenova/bert-base-NER', hint: 'Tag people, organizations and locations.' },
  { task: 'question-answering', label: 'Extractive QA', input: 'qa', defaultModel: 'Xenova/distilbert-base-uncased-distilled-squad', hint: 'Find the answer span inside a context passage.' },
  { task: 'summarization', label: 'Summarization', input: 'text', defaultModel: 'Xenova/distilbart-cnn-6-6', hint: 'Abstractive summary of a passage.' },
  { task: 'translation', label: 'Translation', input: 'text', defaultModel: 'Xenova/nllb-200-distilled-600M', hint: 'Set src_lang / tgt_lang in options, e.g. {"src_lang":"eng_Latn","tgt_lang":"fra_Latn"}.' },
  { task: 'fill-mask', label: 'Fill mask', input: 'text', defaultModel: 'Xenova/bert-base-cased', hint: 'Predict the [MASK] token.' },
  { task: 'image-classification', label: 'Image classification', input: 'image', defaultModel: 'Xenova/vit-base-patch16-224', hint: 'ImageNet labels for an image.' },
  { task: 'object-detection', label: 'Object detection', input: 'image', defaultModel: 'Xenova/detr-resnet-50', hint: 'Boxes and labels for objects in an image.' },
  { task: 'image-to-text', label: 'Image captioning / OCR', input: 'image', defaultModel: 'Xenova/vit-gpt2-image-captioning', hint: 'Describe an image (or use a TrOCR model for handwriting).' },
  { task: 'automatic-speech-recognition', label: 'Speech to text', input: 'audio', defaultModel: 'Xenova/whisper-tiny.en', hint: 'Transcribe an audio file (decoded to 16 kHz mono in the browser).' },
];

export const DTYPES = ['auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'bnb4', 'q4f16'] as const;
