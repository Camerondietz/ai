# Self-hosted models (optional)

For fully offline or air-gapped use, place Transformers.js-compatible models here and turn off
**Local Lab → Allow downloading models from Hugging Face**. The app then loads models from
`<your site>/models/<owner>/<model>/` instead of the Hub.

Layout mirrors the Hub repository, for example:

```
public/models/onnx-community/all-MiniLM-L6-v2-ONNX/
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/model_quantized.onnx
```

Download a repository with the Hugging Face CLI:

```bash
hf download onnx-community/all-MiniLM-L6-v2-ONNX --local-dir public/models/onnx-community/all-MiniLM-L6-v2-ONNX
```

Everything in this folder except this README is git-ignored by default, because weights are large.
GitHub Pages limits individual files to 100 MB and sites to 1 GB.
