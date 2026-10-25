
import hmac
import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

app = FastAPI(
    title="ZetaCard Email Service",
    version="1.1.0",
    docs_url=None,
    redoc_url=None,
)

bearer_scheme = HTTPBearer(auto_error=False)


def verify_api_key(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    expected_key = os.environ.get("ZETACARD_API_KEY")

    if not expected_key:
        raise HTTPException(
            status_code=503,
            detail="Service authentication is not configured",
        )

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Unauthorized")

    if not hmac.compare_digest(credentials.credentials, expected_key):
        raise HTTPException(status_code=401, detail="Unauthorized")

    return True


@app.get("/")
def health_check():
    return {
        "service": "ZetaCard Email Service",
        "status": "running",
    }


@app.get("/internal/status")
def protected_status(
    authenticated: bool = Depends(verify_api_key),
):
    return {
        "service": "ZetaCard Email Service",
        "authenticated": authenticated,
        "email_sending": "not_configured",
    }
