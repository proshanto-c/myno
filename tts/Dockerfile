# FastPitch + HiFi-GAN TTS on the NeMo container.
FROM nvcr.io/nvidia/nemo:25.09

WORKDIR /app
# The NeMo base image can contain NVIDIA packages whose own constraints do not
# exactly match the CUDA/PyTorch stack shipped in the image. We only need to add
# the FastAPI server layer here, so do not fail/noise on those pre-existing
# resolver conflicts.
RUN pip install --no-cache-dir --no-warn-conflicts fastapi==0.115.* "uvicorn[standard]"==0.32.* soundfile==0.12.*

COPY nemo_tts_server.py .

EXPOSE 8001
CMD ["python", "nemo_tts_server.py"]
