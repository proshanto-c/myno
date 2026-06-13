FROM python:3.11-slim

WORKDIR /app
RUN pip install --no-cache-dir \
    fastapi==0.115.* "uvicorn[standard]"==0.32.* \
    sqlalchemy==2.0.* psycopg2-binary==2.9.* httpx==0.27.* pydantic==2.*

COPY main.py .

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
