# FastPitch + HiFi-GAN TTS on the NeMo container.
FROM nvcr.io/nvidia/nemo:25.09

WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.* "uvicorn[standard]"==0.32.* soundfile==0.12.*

COPY nemo_tts_server.py .

EXPOSE 8001
CMD ["python", "nemo_tts_server.py"]
