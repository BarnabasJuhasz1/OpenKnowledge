import os
import torch
import torch.nn as nn
from transformers import AutoModel

class MultiTaskClassifier(nn.Module):
    """Custom sequence classifier with two classification heads:
    one for primary (main_archetype) and one for secondary (second_tier_archetype).
    """
    def __init__(self, encoder, num_primary, num_secondary, id2label_primary, id2label_secondary):
        super().__init__()
        self.encoder = encoder
        self.config = encoder.config
        self.dropout = nn.Dropout(self.config.hidden_dropout_prob if hasattr(self.config, "hidden_dropout_prob") else 0.1)
        self.primary_classifier = nn.Linear(self.config.hidden_size, num_primary)
        self.secondary_classifier = nn.Linear(self.config.hidden_size, num_secondary)
        
        self.num_primary = num_primary
        self.num_secondary = num_secondary
        self.id2label_primary = id2label_primary
        self.id2label_secondary = id2label_secondary
        
    def forward(self, input_ids=None, attention_mask=None, token_type_ids=None, labels=None, **kwargs):
        outputs = self.encoder(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
            **kwargs
        )
        
        # Extract pooled output (CLS token representation or pooler output)
        pooled_output = outputs[1] if (len(outputs) > 1 and outputs[1] is not None) else None
        if pooled_output is None:
            # fallback for models like DistilBERT that don't have a pooler
            pooled_output = outputs[0][:, 0]
            
        pooled_output = self.dropout(pooled_output)
        primary_logits = self.primary_classifier(pooled_output)
        secondary_logits = self.secondary_classifier(pooled_output)
        
        loss = None
        if labels is not None:
            # labels shape: [batch_size, 2]
            primary_labels = labels[:, 0]
            secondary_labels = labels[:, 1]
            
            loss_fct = nn.CrossEntropyLoss()
            loss_primary = loss_fct(primary_logits, primary_labels)
            loss_secondary = loss_fct(secondary_logits, secondary_labels)
            loss = loss_primary + loss_secondary
            
        return {
            "loss": loss,
            "logits": (primary_logits, secondary_logits)
        }
        
    def state_dict(self, *args, **kwargs):
        state = super().state_dict(*args, **kwargs)
        # Safetensors requires all tensors to be contiguous
        return {k: v.contiguous() if isinstance(v, torch.Tensor) else v for k, v in state.items()}

    def save_pretrained(self, save_directory, **kwargs):
        # Save base transformer config and weights
        self.encoder.save_pretrained(save_directory, **kwargs)
        
        # Save custom classification heads and metadata
        os.makedirs(save_directory, exist_ok=True)
        state_dict = {
            "primary_classifier.weight": self.primary_classifier.weight,
            "primary_classifier.bias": self.primary_classifier.bias,
            "secondary_classifier.weight": self.secondary_classifier.weight,
            "secondary_classifier.bias": self.secondary_classifier.bias,
            "num_primary": self.num_primary,
            "num_secondary": self.num_secondary,
            "id2label_primary": self.id2label_primary,
            "id2label_secondary": self.id2label_secondary,
        }
        torch.save(state_dict, os.path.join(save_directory, "multitask_classifier_head.bin"))
        
    @classmethod
    def from_pretrained(cls, save_directory, model_name=None):
        from safetensors.torch import load_file
        
        import json
        
        # Load label mapping metadata
        mapping_path = os.path.join(save_directory, "label_mapping.json")
        if not os.path.exists(mapping_path):
            # If not in the checkpoint directory, check parent directory (args.output_dir)
            parent_dir = os.path.dirname(save_directory)
            mapping_path = os.path.join(parent_dir, "label_mapping.json")
            
        if not os.path.exists(mapping_path):
            raise FileNotFoundError(f"Could not find label_mapping.json in {save_directory} or its parent {os.path.dirname(save_directory)}")
            
        with open(mapping_path, "r", encoding="utf-8") as f:
            mapping = json.load(f)
            
        id2label_primary = mapping["primary"]
        id2label_secondary = mapping["secondary"]
        num_primary = len(id2label_primary)
        num_secondary = len(id2label_secondary)
        
        # Load base model structure
        load_path = save_directory if os.path.exists(os.path.join(save_directory, "config.json")) else model_name
        if load_path is None:
            load_path = "allenai/scibert_scivocab_uncased"
            
        encoder = AutoModel.from_pretrained(load_path)
        
        # Instantiate model structure
        model = cls(encoder, num_primary, num_secondary, id2label_primary, id2label_secondary)
        
        # Load weights from checkpoint (model.safetensors or pytorch_model.bin)
        safetensors_path = os.path.join(save_directory, "model.safetensors")
        bin_path = os.path.join(save_directory, "pytorch_model.bin")
        
        if os.path.exists(safetensors_path):
            state_dict = load_file(safetensors_path, device="cpu")
        elif os.path.exists(bin_path):
            state_dict = torch.load(bin_path, map_location="cpu", weights_only=True)
        else:
            raise FileNotFoundError(f"Could not find model.safetensors or pytorch_model.bin in {save_directory}")
            
        # Load full model weights
        model.load_state_dict(state_dict)
        return model
