"""大模型层：看候选分的缩略图，判断谁赢了这一分。

走 OpenAI 兼容的 chat/completions 接口（多数大模型服务都支持）。
配置全部来自环境变量，见 .env.example。LLM_API_KEY 为空时整层跳过。
"""
import base64
import json
import os

import httpx


def _cfg():
    return {
        "key": os.environ.get("LLM_API_KEY", "").strip(),
        "base": os.environ.get("LLM_BASE_URL", "").strip().rstrip("/"),
        "model": os.environ.get("LLM_MODEL", "").strip(),
    }


def enabled():
    c = _cfg()
    return bool(c["key"] and c["base"] and c["model"])


SIDE_DESC = {
    "far": "画面中网的另一侧、离镜头较远的选手",
    "near": "画面中离镜头较近的选手",
}

PROMPT = """这是一段乒乓球训练视频里某一分结束前后的画面，按时间顺序从左到右、从上到下排列，每格间隔 0.5 秒，共 4.5 秒。
最后一次击球大约在第 7 格（第 3 秒）。
“我”是{me}，另一位是教练。

请判断这一分的结果：
- me：我赢了这一分（教练没接到、回球下网或出界）
- coach：教练赢了这一分
- practice：这不是比赛对打，而是喂球、发球练习或捡球
- unclear：画面看不清，无法判断

只输出 JSON：{{"winner": "me|coach|practice|unclear", "confidence": "high|medium|low", "evidence": "一句话，指出是哪一格看到了什么"}}"""


def _ask(image_b64, me_side):
    c = _cfg()
    body = {
        "model": c["model"],
        "temperature": 0.2,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT.format(me=SIDE_DESC.get(me_side, SIDE_DESC["far"]))},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
            ],
        }],
    }
    r = httpx.post(f"{c['base']}/chat/completions", json=body, timeout=60,
                   headers={"Authorization": f"Bearer {c['key']}"})
    r.raise_for_status()
    text = r.json()["choices"][0]["message"]["content"]
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start:end + 1])
    if data.get("winner") not in {"me", "coach", "practice", "unclear"}:
        data["winner"] = "unclear"
    return data


def judge_point(sheet_path, me_side):
    """独立问两次，结论一致才采纳（status=agreed），否则交给人工（status=disagreed）。"""
    if not enabled():
        return {"status": "skipped_no_key"}
    with open(sheet_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    try:
        a, b = _ask(b64, me_side), _ask(b64, me_side)
    except Exception as e:  # noqa: BLE001 — 调用失败不影响主流程，转人工
        return {"status": "error", "error": f"{type(e).__name__}: {e}"}
    agreed = a["winner"] == b["winner"] and a["winner"] != "unclear"
    return {
        "status": "agreed" if agreed else "disagreed",
        "winner": a["winner"] if agreed else "unclear",
        "confidence": a.get("confidence"),
        "evidence": a.get("evidence"),
        "votes": [a["winner"], b["winner"]],
    }
