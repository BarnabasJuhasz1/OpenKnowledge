# Subtask 01 — Standalone classifier script + config + conda env

## Conda env
- Create `okarchetype` (python 3.12) with `torch transformers safetensors`.
  Do NOT install torchvision (transformers imports it lazily and a mismatched
  torchvision breaks the bert module import — clean stack avoids this).
- Interpreter: `/home/juhasz/miniforge3/envs/okarchetype/bin/python`.

## Config file
`backend/app/services/archetype/config.json` (overridable via `ARCHETYPE_CONFIG_PATH`):
```json
{
  "enabled": true,
  "python_executable": "/home/juhasz/miniforge3/envs/okarchetype/bin/python",
  "script_path": ".../archetype_classifier/classifier/classify_retrieved_papers.py",
  "checkpoint_dir": ".../models/fast_archetype_model/checkpoint-6402",
  "label_mapping_path": ".../models/fast_archetype_model/label_mapping.json",
  "encoder_config": { standard scibert/bert-base config: vocab 31090, hidden 768,
                      12 layers, 12 heads, intermediate 3072, max_pos 512,
                      type_vocab 2, gelu, dropout 0.1, layer_norm_eps 1e-12,
                      pad_token_id 0, model_type bert },
  "batch_size": 64,
  "max_length": 512,
  "device": "auto",
  "preload_on_startup": true,
  "request_timeout_seconds": 120,
  "startup_timeout_seconds": 180
}
```
Also write a `config.example.json` documenting each field.

## Script: `archetype_classifier/classifier/classify_retrieved_papers.py`
- Imports `MultiTaskClassifier` from the sibling `model.py` (sys.path).
- `load_model(cfg)`: build `AutoConfig.for_model(**encoder_config)`,
  `AutoModel.from_config(...)`, wrap in `MultiTaskClassifier` with label mapping,
  `load_state_dict(load_file(checkpoint/model.safetensors), strict=False)`,
  load tokenizer from checkpoint, move to device, eval. (Do NOT use
  `MultiTaskClassifier.from_pretrained` — it needs SciBERT/network and fails offline.)
- `classify(texts) -> list[(primary, secondary, p_conf, s_conf)]` batched, softmax+argmax.
- Modes:
  - `serve`: print `{"event":"ready"}` to stdout once loaded; loop reading stdin
    lines, each `{"id":<int>,"items":[{"id":"..","abstract":".."}]}`, respond
    `{"id":<int>,"results":[{"id":"..","primary":"..","secondary":"..",
    "main_confidence":..,"second_confidence":..}]}`. Empty/blank abstracts →
    null archetypes (skip model). ALL logging to stderr.
  - `batch`: `--input in.json --output out.json` for testing.
- Force offline HF env vars at top.

## Test
`echo '{"id":1,"items":[{"id":"a","abstract":"We present a new transformer ..."}]}' \
  | okarchetype/bin/python classify_retrieved_papers.py serve --config config.json`
→ expect a `ready` line then a results line with a plausible archetype.
Also run batch mode on 3 sample abstracts.
