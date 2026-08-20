FROM python:3.11-slim

WORKDIR /app
# defusedxml because efetch is XML-only and this is third-party input: stdlib
# ElementTree will happily parse a hostile document.
RUN pip install --no-cache-dir \
    fastapi==0.115.* "uvicorn[standard]"==0.32.* \
    sqlalchemy==2.0.* psycopg2-binary==2.9.* httpx==0.27.* pydantic==2.* \
    defusedxml==0.7.*

COPY *.py ./

EXPOSE 9000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
