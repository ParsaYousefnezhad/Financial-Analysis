from fastapi import APIRouter, Request
from fastapi.templating import Jinja2Templates
from config import INCODE_TO_NAME, BASE_DIR
from database import get_all_inscodes

router = APIRouter()
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

def _page_assets():
    inscodes = get_all_inscodes() or list(INCODE_TO_NAME.keys())
    return [{"value": c, "label": INCODE_TO_NAME.get(c, c)} for c in inscodes]

@router.get("/ai")
async def ai_page(request: Request):
    return templates.TemplateResponse("ai.html",
                                      {"request": request, "assets": _page_assets()})