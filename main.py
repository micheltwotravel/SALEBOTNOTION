from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from notion_client import Client
from dotenv import load_dotenv
import os
import re
import unicodedata

load_dotenv()

NOTION_API_KEY = os.getenv("NOTION_API_KEY")
NOTION_DATA_SOURCE_ID = os.getenv("NOTION_DATA_SOURCE_ID")

if not NOTION_API_KEY:
    raise ValueError("Falta NOTION_API_KEY en .env")

if not NOTION_DATA_SOURCE_ID:
    raise ValueError("Falta NOTION_DATA_SOURCE_ID en .env")

notion = Client(auth=NOTION_API_KEY)
app = FastAPI(title="Two Travel Sales Bot - Notion")

class SearchRequest(BaseModel):
    text: str
    limit: int = 5

def normalize_text(value):
    if value is None:
        return ""
    text = str(value).strip().lower()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"\s+", " ", text)
    return text

def extract_filters(text: str):
    t = normalize_text(text)

    city = None
    if "cartagena" in t:
        city = "Cartagena"
    elif "medellin" in t:
        city = "Medellín"
    elif "tulum" in t:
        city = "Tulum"
    elif "mexico city" in t or "cdmx" in t:
        city = "Mexico City"

    item_type = None
    if any(x in t for x in ["villa", "casa", "house", "property"]):
        item_type = "Villa"
    elif any(x in t for x in ["boat", "lancha", "speedboat"]):
        item_type = "Boat"
    elif any(x in t for x in ["yacht", "yate", "catamaran"]):
        item_type = "Yacht"
    elif any(x in t for x in ["wedding", "venue", "boda", "salon"]):
        item_type = "Wedding Venue"

    pax_min = None
    pax_patterns = [
        r"para\s+(\d{1,3})",
        r"for\s+(\d{1,3})",
        r"(\d{1,3})\s*(?:pax|people|personas|guests|huespedes|huéspedes)"
    ]
    for pattern in pax_patterns:
        m = re.search(pattern, t)
        if m:
            pax_min = int(m.group(1))
            break

    bedrooms_min = None
    bedroom_patterns = [
        r"(\d{1,2})\s*(?:hab|habitaciones|cuartos|bedrooms|rooms)"
    ]
    for pattern in bedroom_patterns:
        m = re.search(pattern, t)
        if m:
            bedrooms_min = int(m.group(1))
            break

    return {
        "city": city,
        "item_type": item_type,
        "pax_min": pax_min,
        "bedrooms_min": bedrooms_min
    }

def get_text(prop):
    if not prop:
        return None
    prop_type = prop.get("type")
    if prop_type == "title":
        return "".join([x.get("plain_text", "") for x in prop.get("title", [])]).strip() or None
    if prop_type == "rich_text":
        return "".join([x.get("plain_text", "") for x in prop.get("rich_text", [])]).strip() or None
    if prop_type == "select":
        val = prop.get("select")
        return val.get("name") if val else None
    if prop_type == "multi_select":
        vals = prop.get("multi_select", [])
        return [v.get("name") for v in vals if v.get("name")]
    if prop_type == "number":
        return prop.get("number")
    if prop_type == "url":
        return prop.get("url")
    if prop_type == "status":
        val = prop.get("status")
        return val.get("name") if val else None
    return None

def page_to_item(page):
    props = page.get("properties", {})

    return {
        "name": get_text(props.get("Name")),
        "item_type": get_text(props.get("Item Type")),
        "city": get_text(props.get("City")),
        "neighborhood": get_text(props.get("Neighborhood")),
        "location": get_text(props.get("Location")),
        "bedrooms": get_text(props.get("Bedrooms")),
        "max_pax": get_text(props.get("Max Pax")),
        "client_price": get_text(props.get("Client Price")),
        "description": get_text(props.get("Description")),
        "amenities": get_text(props.get("Amenities")),
        "photos_link": get_text(props.get("Photos Link")),
        "source_link": get_text(props.get("Twp Travel Webpage")),
        "status": get_text(props.get("Status")),
        "notion_page_url": page.get("url")
    }

def matches_filters(item, filters):
    if filters["city"] and item.get("city") != filters["city"]:
        return False
    if filters["item_type"] and item.get("item_type") != filters["item_type"]:
        return False

    if filters["pax_min"] is not None:
        try:
            if item.get("max_pax") is None or int(item["max_pax"]) < filters["pax_min"]:
                return False
        except:
            return False

    if filters["bedrooms_min"] is not None:
        try:
            if item.get("bedrooms") is None or int(item["bedrooms"]) < filters["bedrooms_min"]:
                return False
        except:
            return False

    return True

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/debug-search")
def debug_search():
    try:
        results = notion.search(query="Two_Travel_Master_Inventory")
        return results
    except Exception as e:
        return {"error": str(e)}

@app.post("/search")
def search(req: SearchRequest):
    filters = extract_filters(req.text)

    try:
        response = notion.data_sources.query(
            data_source_id=NOTION_DATA_SOURCE_ID,
            page_size=100
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error consultando Notion: {str(e)}")

    pages = response.get("results", [])
    items = [page_to_item(p) for p in pages]
    matches = [item for item in items if matches_filters(item, filters)]

    return {
        "understood_filters": filters,
        "count": len(matches),
        "results": matches[:req.limit]
    }
