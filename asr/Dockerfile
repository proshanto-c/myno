# Cache-aware streaming ASR (nvidia/nemotron-speech-streaming-en-0.6b).
# Base on NVIDIA's NeMo container so CUDA + PyTorch + NeMo are already set up.
# Pick a current tag from NGC: https://catalog.ngc.nvidia.com/orgs/nvidia/containers/nemo
FROM nvcr.io/nvidia/nemo:25.09

WORKDIR /app
# The NeMo base image can contain NVIDIA packages whose own constraints do not
# exactly match the CUDA/PyTorch stack shipped in the image. We only need to add
# the FastAPI server layer here, so do not fail/noise on those pre-existing
# resolver conflicts.
RUN pip install --no-cache-dir --no-warn-conflicts fastapi==0.115.* "uvicorn[standard]"==0.32.*

COPY nemo_asr_server.py .

EXPOSE 8000
CMD ["python", "nemo_asr_server.py"]
