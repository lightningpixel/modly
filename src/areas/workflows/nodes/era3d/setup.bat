@echo off
REM Era3D Multi-View Extension — venv setup script for Windows
REM Run this once from the era3d extension directory to create the venv.
REM
REM Usage (from the extension directory):
REM   setup.bat
REM
REM The script will:
REM   1. Create a Python venv at .\venv\
REM   2. Install PyTorch 2.1.2 (CUDA 12.1) + pinned Era3D dependencies
REM   3. Clone Era3D repo for custom mvdiffusion pipeline modules
REM   4. Patch Era3D for diffusers 0.26.0 compatibility

setlocal

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

echo [Era3D Setup] Creating Python virtual environment...
python -m venv venv
if errorlevel 1 (
    echo [Era3D Setup] ERROR: Failed to create venv. Make sure Python 3.10+ is installed.
    exit /b 1
)

echo [Era3D Setup] Upgrading pip...
venv\Scripts\python.exe -m pip install --upgrade pip --quiet

echo [Era3D Setup] Installing PyTorch 2.1.2 with CUDA 12.1 support...
venv\Scripts\pip.exe install torch==2.1.2 torchvision==0.16.2 --index-url https://download.pytorch.org/whl/cu121 --quiet
if errorlevel 1 (
    echo [Era3D Setup] ERROR: PyTorch install failed. Check your internet connection.
    exit /b 1
)

echo [Era3D Setup] Installing Era3D dependencies (pinned for compatibility)...
venv\Scripts\pip.exe install ^
    "diffusers[torch]==0.26.0" ^
    "transformers==4.37.2" ^
    "accelerate==0.21.0" ^
    "huggingface_hub==0.20.3" ^
    "numpy==1.26.4" ^
    "einops" ^
    "Pillow>=10.0.0" ^
    "omegaconf>=2.3.0" ^
    "kornia>=0.7.0" ^
    "rembg==2.0.50" ^
    "opencv-python-headless" ^
    "icecream" ^
    --quiet

if errorlevel 1 (
    echo [Era3D Setup] ERROR: Dependency install failed.
    exit /b 1
)

REM Clone Era3D repo for custom pipeline code (mvdiffusion modules)
echo [Era3D Setup] Cloning Era3D repository for custom pipeline modules...
if exist era3d-repo (
    echo [Era3D Setup] era3d-repo already exists, skipping clone.
) else (
    git clone --depth 1 https://github.com/pengHTYX/Era3D.git era3d-repo
    if errorlevel 1 (
        echo [Era3D Setup] ERROR: Failed to clone Era3D repo. Make sure git is installed and you have internet access.
        exit /b 1
    )
)

REM Apply all compatibility patches via Python script
echo [Era3D Setup] Applying compatibility patches...
venv\Scripts\python.exe -c "
import pathlib, subprocess, sys

repo = pathlib.Path('era3d-repo')

# 1. Patch pipeline: CLIPFeatureExtractor removed in transformers>=4.27
f = repo / 'mvdiffusion/pipelines/pipeline_mvdiffusion_unclip.py'
t = f.read_text()
old = 'from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection, CLIPFeatureExtractor, CLIPTokenizer, CLIPTextModel'
new = 'from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection, CLIPTokenizer, CLIPTextModel\ntry:\n    from transformers import CLIPFeatureExtractor\nexcept ImportError:\n    CLIPFeatureExtractor = CLIPImageProcessor'
if old in t:
    f.write_text(t.replace(old, new))
    print('[Era3D Setup] Patched pipeline CLIPFeatureExtractor.')

# 2. Patch unet: _load_state_dict_into_model and unet_2d_blocks moved
f2 = repo / 'mvdiffusion/models/unet_mv2d_condition.py'
t2 = f2.read_text()
if 'from diffusers.models.modeling_utils import ModelMixin, load_state_dict, _load_state_dict_into_model' in t2:
    t2 = t2.replace(
        'from diffusers.models.modeling_utils import ModelMixin, load_state_dict, _load_state_dict_into_model',
        'from diffusers.models.modeling_utils import ModelMixin\ntry:\n    from diffusers.models.modeling_utils import load_state_dict, _load_state_dict_into_model\nexcept ImportError:\n    try:\n        from diffusers.models.model_loading_utils import load_state_dict, _load_state_dict_into_model\n    except ImportError:\n        from diffusers.models.model_loading_utils import load_state_dict\n        def _load_state_dict_into_model(model, state_dict):\n            model.load_state_dict(state_dict, strict=False)\n            return []'
    )
    f2.write_text(t2)
    print('[Era3D Setup] Patched unet modeling_utils imports.')

print('[Era3D Setup] All patches applied.')
"

echo.
echo [Era3D Setup] Done! The Era3D extension is ready.
echo [Era3D Setup] The model weights (~8GB) will be downloaded automatically on first use.
echo [Era3D Setup] Make sure your HuggingFace token is set in Modly Settings ^> Integrations.
echo.

endlocal
