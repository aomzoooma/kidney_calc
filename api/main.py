"""Application entry point; health is not a readiness or clinical check."""

from fastapi import FastAPI


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/health')
def health():
    return {'status': 'ok'}
