import os
import requests
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

SLACK_BOT_TOKEN = os.environ["SLACK_BOT_TOKEN"]      # xoxb-...
SLACK_APP_TOKEN = os.environ["SLACK_APP_TOKEN"]      # xapp-...
API_URL = "https://salebotnotion.onrender.com/search"

app = App(token=SLACK_BOT_TOKEN)

@app.event("app_mention")
def handle_app_mention(body, say, logger):
    try:
        text = body["event"].get("text", "")
        # quita la mención del bot
        parts = text.split(">", 1)
        clean_text = parts[1].strip() if len(parts) > 1 else text.strip()

        res = requests.post(API_URL, json={
            "text": clean_text,
            "limit": 5
        }, timeout=30)
        res.raise_for_status()
        data = res.json()

        if data.get("count", 0) == 0:
            say("No encontré opciones con esa búsqueda.")
            return

        msg = [f"Encontré {data['count']} opciones. Te dejo las primeras {len(data['results'])}:"]

        for r in data["results"]:
            line = f"• *{r.get('name','Sin nombre')}*"
            if r.get("neighborhood"):
                line += f" — {r['neighborhood']}"
            if r.get("max_pax"):
                line += f" — pax: {r['max_pax']}"
            if r.get("bedrooms"):
                line += f" — hab: {r['bedrooms']}"
            msg.append(line)

            if r.get("photos_link"):
                msg.append(f"  Fotos: {r['photos_link']}")
            if r.get("notion_page_url"):
                msg.append(f"  Notion: {r['notion_page_url']}")

        say("\n".join(msg))

    except Exception as e:
        logger.exception("Slack bot error")
        say(f"Me dio error procesando esa búsqueda: {e}")

if __name__ == "__main__":
    SocketModeHandler(app, SLACK_APP_TOKEN).start()
