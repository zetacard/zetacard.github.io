from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="ZetaCard Email Service",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],  # Configure your real website origin before browser use
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.get("/")
def health_check():
    return {
        "service": "ZetaCard Email Service",
        "status": "running"
    }
