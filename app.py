"""
TeleHarvest - Telegram Member Scraper & Marketing Tool
Flask backend with SocketIO for real-time updates
"""

import os
import json
import asyncio
import threading
import csv
import time
import logging
import re
from datetime import datetime
from functools import wraps

from flask import Flask, render_template, request, jsonify, send_file, session
from flask_socketio import SocketIO, emit
from flask_cors import CORS

import telethon
from telethon import TelegramClient, events
from telethon.tl.functions.channels import GetParticipantsRequest
from telethon.tl.types import ChannelParticipantsSearch
from telethon.errors import (
    SessionPasswordNeededError,
    PhoneCodeInvalidError,
    FloodWaitError,
    UserPrivacyRestrictedError,
    UserNotMutualContactError,
    PeerFloodError,
    ChatWriteForbiddenError,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.urandom(24).hex()
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STORAGE_DIR = os.environ.get("STORAGE_DIR", BASE_DIR)

SESSIONS_DIR = os.path.join(STORAGE_DIR, "sessions")
DATA_DIR = os.path.join(STORAGE_DIR, "data")
EXPORTS_DIR = os.path.join(STORAGE_DIR, "exports")
ACCOUNTS_FILE = os.path.join(DATA_DIR, "accounts.json")

for d in [SESSIONS_DIR, DATA_DIR, EXPORTS_DIR]:
    os.makedirs(d, exist_ok=True)

# ─── In-Memory State ──────────────────────────────────────────────────────────
accounts = {}          # phone -> {api_id, api_hash, status, phone}
clients = {}           # phone -> TelegramClient (connected)
pending_codes = {}     # phone -> {"client": ..., "phone_code_hash": ...}
scraped_members = {}   # session_id -> [member dicts]
active_tasks = {}      # task_id -> {"status", "progress", "total", "log"}

# ─── Load / Save Accounts ─────────────────────────────────────────────────────

def load_accounts():
    global accounts
    if os.path.exists(ACCOUNTS_FILE):
        with open(ACCOUNTS_FILE) as f:
            accounts = json.load(f)

def save_accounts():
    with open(ACCOUNTS_FILE, "w") as f:
        json.dump(accounts, f, indent=2)

load_accounts()

# ─── Async Helpers ────────────────────────────────────────────────────────────

global_loop = None

def start_global_loop():
    global global_loop
    global_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(global_loop)
    global_loop.run_forever()

loop_thread = threading.Thread(target=start_global_loop, daemon=True)
loop_thread.start()

# Wait briefly for loop to start up
time.sleep(0.1)

def run_async(coro):
    """Run an async coroutine in the global event loop in a thread-safe manner."""
    future = asyncio.run_coroutine_threadsafe(coro, global_loop)
    return future.result()

@app.before_request
def log_request_info():
    print(f"📥 REQUEST: {request.method} {request.path}", flush=True)
    if request.is_json and request.json:
        # Hide sensitive keys in log if printing
        clean_json = {k: ("***" if "hash" in k or "pass" in k or "code" in k else v) for k, v in request.json.items()}
        print(f"📦 PAYLOAD: {clean_json}", flush=True)

@app.errorhandler(Exception)
def handle_exception(e):
    from werkzeug.exceptions import NotFound
    if isinstance(e, NotFound):
        return jsonify({"error": str(e)}), 404
    import traceback
    print("🚨 SERVER EXCEPTION:", flush=True)
    traceback.print_exc()
    return jsonify({"error": str(e)}), 500

# ─── Account Routes ───────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/accounts", methods=["GET"])
def get_accounts():
    result = []
    for phone, data in accounts.items():
        result.append({
            "phone": phone,
            "api_id": data.get("api_id"),
            "status": data.get("status", "disconnected"),
            "name": data.get("name", ""),
        })
    return jsonify(result)

@app.route("/api/accounts/add", methods=["POST"])
def add_account():
    """Step 1: Register account and send OTP."""
    data = request.json
    phone = data.get("phone", "").strip()
    api_id = data.get("api_id", "").strip()
    api_hash = data.get("api_hash", "").strip()

    phone = re.sub(r'[^\d+]', '', phone)
    if not all([phone, api_id, api_hash]):
        return jsonify({"error": "phone, api_id, and api_hash are required"}), 400

    # If there's an existing client or pending attempt, disconnect it first
    if phone in pending_codes:
        try:
            old_pending = pending_codes[phone]
            old_pending["loop"].run_until_complete(old_pending["client"].disconnect())
        except Exception:
            pass
        del pending_codes[phone]

    if phone in clients:
        try:
            run_async(clients[phone].disconnect())
        except Exception:
            pass
        del clients[phone]

    def _send_code():
        client = TelegramClient(
            os.path.join(SESSIONS_DIR, phone),
            int(api_id),
            api_hash,
        )
        async def _inner():
            await client.connect()
            result = await client.send_code_request(phone)
            return result.phone_code_hash

        try:
            phone_code_hash = run_async(_inner())
            pending_codes[phone] = {"client": client, "phone_code_hash": phone_code_hash}
            accounts[phone] = {"phone": phone, "api_id": api_id, "api_hash": api_hash, "status": "pending_otp"}
            save_accounts()
            return None
        except Exception as e:
            return str(e)

    error = _send_code()
    if error:
        return jsonify({"error": error}), 500

    return jsonify({"message": "OTP sent", "phone": phone})

@app.route("/api/accounts/verify", methods=["POST"])
def verify_account():
    """Step 2: Verify OTP (and optional 2FA password)."""
    data = request.json
    phone = data.get("phone", "").strip()
    code = data.get("code", "").strip()
    password = data.get("password", "").strip()

    phone = re.sub(r'[^\d+]', '', phone)
    if phone not in pending_codes:
        return jsonify({"error": "No pending OTP for this phone. Please click Send OTP first."}), 400

    pending = pending_codes[phone]
    client = pending["client"]
    phone_code_hash = pending["phone_code_hash"]

    async def _inner():
        try:
            await client.sign_in(phone, code, phone_code_hash=phone_code_hash)
        except SessionPasswordNeededError:
            if not password:
                raise ValueError("2FA_REQUIRED")
            await client.sign_in(password=password)
        me = await client.get_me()
        return me

    try:
        me = run_async(_inner())
        name = f"{me.first_name or ''} {me.last_name or ''}".strip() or phone
        accounts[phone]["status"] = "connected"
        accounts[phone]["name"] = name
        clients[phone] = client
        save_accounts()
        del pending_codes[phone]
        return jsonify({"message": "Account connected", "name": name})
    except ValueError as e:
        if "2FA_REQUIRED" in str(e):
            return jsonify({"error": "2FA_REQUIRED"}), 403
        return jsonify({"error": str(e)}), 400
    except PhoneCodeInvalidError:
        return jsonify({"error": "Invalid OTP code"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/accounts/delete", methods=["POST"])
def delete_account():
    phone = request.json.get("phone")
    if phone:
        phone = re.sub(r'[^\d+]', '', phone)
    if phone in clients:
        try:
            run_async(clients[phone].disconnect())
        except Exception:
            pass
        del clients[phone]
    if phone in accounts:
        del accounts[phone]
        save_accounts()
    session_file = os.path.join(SESSIONS_DIR, f"{phone}.session")
    if os.path.exists(session_file):
        os.remove(session_file)
    return jsonify({"message": "Account removed"})

# ─── Connect existing session files on startup ────────────────────────────────

def connect_saved_accounts():
    for phone, data in list(accounts.items()):
        if data.get("status") == "connected" and phone not in clients:
            session_path = os.path.join(SESSIONS_DIR, phone)
            if os.path.exists(session_path + ".session"):
                try:
                    client = TelegramClient(session_path, int(data["api_id"]), data["api_hash"])
                    run_async(client.connect())
                    if run_async(client.is_user_authorized()):
                        clients[phone] = client
                        logger.info(f"Reconnected: {phone}")
                    else:
                        accounts[phone]["status"] = "disconnected"
                        save_accounts()
                except Exception as e:
                    logger.error(f"Could not reconnect {phone}: {e}")
                    accounts[phone]["status"] = "disconnected"
                    save_accounts()

# ─── Scraper Routes ───────────────────────────────────────────────────────────

@app.route("/api/scrape", methods=["POST"])
def scrape_members():
    data = request.json
    phone = data.get("phone")
    group_url = data.get("group_url", "").strip()
    limit = int(data.get("limit", 200))
    scrape_filter = data.get("filter", "all")
    task_id = f"scrape_{int(time.time())}"

    if phone not in clients:
        return jsonify({"error": "Account not connected"}), 400
    if not group_url:
        return jsonify({"error": "Group URL/username required"}), 400

    active_tasks[task_id] = {"status": "running", "progress": 0, "total": 0, "log": [], "members": []}

    def _run():
        client = clients[phone]

        async def _scrape():
            try:
                active_tasks[task_id]["log"].append("⏳ Resolving entity details...")
                _emit_task(task_id)

                entity = await client.get_entity(group_url)
                
                # Check if it's a broadcast channel (non-megagroup)
                from telethon.tl.types import Channel, Chat, UserStatusOnline, UserStatusRecently, UserStatusLastWeek
                is_group = False
                if isinstance(entity, Chat):
                    is_group = True
                elif isinstance(entity, Channel):
                    if entity.megagroup:
                        is_group = True

                group_title = getattr(entity, 'title', 'Telegram Group')
                active_tasks[task_id]["log"].append(f"🔗 Connected to: {group_title}")
                
                if not is_group:
                    active_tasks[task_id]["log"].append("⚠️ Notice: This is a broadcast channel. Listing subscribers requires administrator privileges.")
                
                _emit_task(task_id)

                # Get total count
                total = limit
                try:
                    if hasattr(entity, 'participants_count') and entity.participants_count:
                        total = min(entity.participants_count, limit)
                    else:
                        from telethon.tl.functions.channels import GetFullChannelRequest
                        full = await client(GetFullChannelRequest(entity))
                        total = min(full.full_chat.participants_count, limit)
                except Exception:
                    pass

                active_tasks[task_id]["total"] = total
                active_tasks[task_id]["log"].append(f"📡 Scraping up to {total} members (filter: {scrape_filter})...")
                _emit_task(task_id)

                inspected = 0
                members = []
                # Use client.iter_participants which is optimized and fast
                async for u in client.iter_participants(entity, limit=limit):
                    inspected += 1
                    if u.bot:
                        continue
                    
                    # Apply activity filter
                    if scrape_filter == "online":
                        if not isinstance(u.status, UserStatusOnline):
                            continue
                    elif scrape_filter == "active":
                        if not isinstance(u.status, (UserStatusOnline, UserStatusRecently, UserStatusLastWeek)):
                            continue

                    members.append({
                        "id": u.id,
                        "username": u.username or "",
                        "first_name": u.first_name or "",
                        "last_name": u.last_name or "",
                        "phone": u.phone or "",
                        "is_bot": u.bot,
                    })
                    
                    progress = len(members)
                    # Emit status update in chunks to save socket performance
                    if inspected % 20 == 0 or progress >= total:
                        active_tasks[task_id]["progress"] = progress
                        active_tasks[task_id]["members"] = members
                        active_tasks[task_id]["log"].append(f"📥 Inspected {inspected} users. Saved {progress} members...")
                        _emit_task(task_id)
                        await asyncio.sleep(0.01) # cooperative yield

                # Final update
                active_tasks[task_id]["progress"] = len(members)
                active_tasks[task_id]["members"] = members
                active_tasks[task_id]["status"] = "done"
                active_tasks[task_id]["log"].append(f"✅ Completed! Successfully harvested {len(members)} matching members after inspecting {inspected} users.")
                _emit_task(task_id)

                # Auto-save to CSV
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                csv_path = os.path.join(EXPORTS_DIR, f"members_{timestamp}.csv")
                _write_csv(members, csv_path)
                active_tasks[task_id]["csv"] = csv_path
                _emit_task(task_id)

            except FloodWaitError as e:
                active_tasks[task_id]["status"] = "error"
                active_tasks[task_id]["log"].append(f"🚫 Flood Wait limit hit: Try again in {e.seconds}s.")
                _emit_task(task_id)
            except Exception as e:
                err_str = str(e)
                if "admin" in err_str.lower() or "privileges" in err_str.lower():
                    active_tasks[task_id]["log"].append("❌ Access Blocked: Telegram requires you to be an administrator to scrape broadcast channel participants. (Groups can be scraped without admin rights).")
                else:
                    active_tasks[task_id]["log"].append(f"❌ Error: {err_str}")
                active_tasks[task_id]["status"] = "error"
                _emit_task(task_id)

        run_async(_scrape())

    socketio.start_background_task(_run)

    return jsonify({"task_id": task_id})

def _emit_task(task_id):
    task = active_tasks.get(task_id, {})
    socketio.emit("task_update", {"task_id": task_id, **{k: v for k, v in task.items() if k != "members"}})

def _write_csv(members, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "username", "first_name", "last_name", "phone"], extrasaction='ignore')
        writer.writeheader()
        writer.writerows(members)

@app.route("/api/tasks", methods=["GET"])
def list_tasks():
    result = []
    for tid, task in active_tasks.items():
        result.append({
            "task_id": tid,
            "status": task.get("status"),
            "progress": task.get("progress"),
            "total": task.get("total"),
            "log": task.get("log", []),
            "sent": task.get("sent"),
            "failed": task.get("failed"),
            "added": task.get("added"),
        })
    return jsonify(result)

@app.route("/api/tasks/<task_id>", methods=["GET"])
def get_task(task_id):
    task = active_tasks.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404
    return jsonify({k: v for k, v in task.items() if k != "members"})

@app.route("/api/tasks/<task_id>/members", methods=["GET"])
def get_task_members(task_id):
    task = active_tasks.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(task.get("members", []))

@app.route("/api/tasks/<task_id>/export", methods=["GET"])
def export_task(task_id):
    task = active_tasks.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404
    members = task.get("members", [])
    if not members:
        return jsonify({"error": "No members to export"}), 400

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(EXPORTS_DIR, f"export_{task_id}_{timestamp}.csv")
    _write_csv(members, path)
    return send_file(path, as_attachment=True, download_name=f"members_{timestamp}.csv")

# ─── Mass DM Routes ───────────────────────────────────────────────────────────

@app.route("/api/dm/send", methods=["POST"])
def send_mass_dm():
    data = request.json
    phone = data.get("phone")
    task_id_src = data.get("task_id")   # scrape task to pull members from
    message = data.get("message", "").strip()
    delay = float(data.get("delay", 5))

    if phone not in clients:
        return jsonify({"error": "Account not connected"}), 400
    if not message:
        return jsonify({"error": "Message required"}), 400

    members = active_tasks.get(task_id_src, {}).get("members", [])
    if not members:
        return jsonify({"error": "No members from that scrape task"}), 400

    dm_task_id = f"dm_{int(time.time())}"
    active_tasks[dm_task_id] = {
        "status": "running",
        "progress": 0,
        "total": len(members),
        "log": [],
        "sent": 0,
        "failed": 0,
    }

    def _run():
        client = clients[phone]

        async def _send():
            sent = 0
            failed = 0
            for i, member in enumerate(members):
                try:
                    target = member.get("username") or int(member.get("id"))
                    await client.send_message(target, message)
                    sent += 1
                    active_tasks[dm_task_id]["log"].append(f"✅ Sent to @{member.get('username') or member.get('id')}")
                except (UserPrivacyRestrictedError, UserNotMutualContactError):
                    failed += 1
                    active_tasks[dm_task_id]["log"].append(f"⛔ Privacy restricted: {member.get('username') or member.get('id')}")
                except PeerFloodError:
                    active_tasks[dm_task_id]["status"] = "error"
                    active_tasks[dm_task_id]["log"].append("🚫 PeerFlood — account may be limited. Stopping.")
                    _emit_task(dm_task_id)
                    return
                except Exception as e:
                    failed += 1
                    active_tasks[dm_task_id]["log"].append(f"❌ Error: {e}")

                active_tasks[dm_task_id]["progress"] = i + 1
                active_tasks[dm_task_id]["sent"] = sent
                active_tasks[dm_task_id]["failed"] = failed
                if len(active_tasks[dm_task_id]["log"]) > 100:
                    active_tasks[dm_task_id]["log"] = active_tasks[dm_task_id]["log"][-100:]
                _emit_task(dm_task_id)
                await asyncio.sleep(delay)

            active_tasks[dm_task_id]["status"] = "done"
            _emit_task(dm_task_id)

        run_async(_send())

    socketio.start_background_task(_run)

    return jsonify({"task_id": dm_task_id})

# ─── Exports listing ──────────────────────────────────────────────────────────

@app.route("/api/exports", methods=["GET"])
def list_exports():
    files = []
    for f in sorted(os.listdir(EXPORTS_DIR), reverse=True):
        if f.endswith(".csv"):
            path = os.path.join(EXPORTS_DIR, f)
            size = os.path.getsize(path)
            files.append({"name": f, "size": size})
    return jsonify(files)

@app.route("/api/exports/<filename>", methods=["GET"])
def download_export(filename):
    path = os.path.join(EXPORTS_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"error": "File not found"}), 404
    return send_file(path, as_attachment=True)

# ─── Group Inviter Routes ──────────────────────────────────────────────────────

@app.route("/api/invite/start", methods=["POST"])
def invite_members():
    data = request.json
    phone = data.get("phone")
    task_id_src = data.get("task_id")   # scrape task to pull members from
    target_group = data.get("target_group", "").strip()
    delay = float(data.get("delay", 30)) # default 30s delay to be safe

    if phone not in clients:
        return jsonify({"error": "Account not connected"}), 400
    if not target_group:
        return jsonify({"error": "Target group required"}), 400

    members = active_tasks.get(task_id_src, {}).get("members", [])
    if not members:
        return jsonify({"error": "No members from that scrape task"}), 400

    invite_task_id = f"invite_{int(time.time())}"
    active_tasks[invite_task_id] = {
        "status": "running",
        "progress": 0,
        "total": len(members),
        "log": [],
        "added": 0,
        "failed": 0,
    }

    def _run():
        from telethon.tl.functions.channels import InviteToChannelRequest
        from telethon.errors import UserAlreadyParticipantError

        client = clients[phone]

        async def _invite():
            added = 0
            failed = 0
            
            try:
                target_entity = await client.get_entity(target_group)
            except Exception as e:
                active_tasks[invite_task_id]["status"] = "error"
                active_tasks[invite_task_id]["log"].append(f"❌ Failed to locate target group: {e}")
                _emit_task(invite_task_id)
                return

            for i, member in enumerate(members):
                try:
                    user_entity = await client.get_entity(member.get("username") or int(member.get("id")))
                    await client(InviteToChannelRequest(target_entity, [user_entity]))
                    added += 1
                    active_tasks[invite_task_id]["log"].append(f"✅ Added @{member.get('username') or member.get('id')}")
                except UserAlreadyParticipantError:
                    failed += 1
                    active_tasks[invite_task_id]["log"].append(f"ℹ️ Already in group: {member.get('username') or member.get('id')}")
                except (UserPrivacyRestrictedError, UserNotMutualContactError):
                    failed += 1
                    active_tasks[invite_task_id]["log"].append(f"⛔ Privacy restricted: {member.get('username') or member.get('id')}")
                except FloodWaitError as e:
                    active_tasks[invite_task_id]["status"] = "error"
                    active_tasks[invite_task_id]["log"].append(f"🚫 Flood Wait for {e.seconds}s. Stopping task to protect account.")
                    _emit_task(invite_task_id)
                    return
                except Exception as e:
                    failed += 1
                    active_tasks[invite_task_id]["log"].append(f"❌ Error: {e}")

                active_tasks[invite_task_id]["progress"] = i + 1
                active_tasks[invite_task_id]["added"] = added
                active_tasks[invite_task_id]["failed"] = failed
                if len(active_tasks[invite_task_id]["log"]) > 100:
                    active_tasks[invite_task_id]["log"] = active_tasks[invite_task_id]["log"][-100:]
                _emit_task(invite_task_id)
                await asyncio.sleep(delay)

            active_tasks[invite_task_id]["status"] = "done"
            _emit_task(invite_task_id)

        run_async(_invite())

    socketio.start_background_task(_run)

    return jsonify({"task_id": invite_task_id})


# ─── Channel Forwarder ─────────────────────────────────────────────────────────

forwarding_tasks = {} # task_id -> {details, handler}

@app.route("/api/forwarder/start", methods=["POST"])
def start_forwarder():
    data = request.json
    phone = data.get("phone")
    source = data.get("source", "").strip()
    target = data.get("target", "").strip()
    keywords = data.get("keywords", "").strip()
    exclude = data.get("exclude", "").strip()
    replace_find = data.get("replace_find", "").strip()
    replace_with = data.get("replace_with", "").strip()
    replace_find_2 = data.get("replace_find_2", "").strip()
    replace_with_2 = data.get("replace_with_2", "").strip()

    if phone not in clients:
        return jsonify({"error": "Account not connected"}), 400
    if not source or not target:
        return jsonify({"error": "Source and Target channels are required"}), 400

    client = clients[phone]
    task_id = f"forward_{int(time.time())}"

    # Parse keywords list
    kw_list = [k.strip().lower() for k in keywords.split(",") if k.strip()]
    ex_list = [e.strip().lower() for e in exclude.split(",") if e.strip()]

    async def _setup():
        try:
            source_entity = await client.get_entity(source)
            target_entity = await client.get_entity(target)
            return source_entity, target_entity, None
        except Exception as e:
            return None, None, str(e)

    source_entity, target_entity, err = run_async(_setup())

    if err:
        return jsonify({"error": f"Failed to resolve channel entities: {err}"}), 400

    # Define the event handler
    async def handler(event):
        try:
            # Retrieve text with formatting (bold, italic, links, etc.) as markdown
            original_text = event.message.text or ""
            text_lower = original_text.lower()
            
            # Keywords matching
            if kw_list:
                if not any(k in text_lower for k in kw_list):
                    return # skip if no keywords match

            # Exclude matching
            if ex_list:
                if any(e in text_lower for e in ex_list):
                    return # skip if any exclude keywords match

            # Link / Description replacement (case-insensitive regex replacement)
            text = original_text
            if replace_find:
                text = re.sub(re.escape(replace_find), replace_with, text, flags=re.IGNORECASE)
            if replace_find_2:
                text = re.sub(re.escape(replace_find_2), replace_with_2, text, flags=re.IGNORECASE)

            # Send/Forward message with modified text and original media/buttons
            await client.send_message(target_entity, text, file=event.message.media, buttons=event.message.buttons)
            
            # Broadcast to web app UI that we forwarded a message
            socketio.emit("forward_log", {
                "task_id": task_id,
                "timestamp": datetime.now().strftime("%H:%M:%S"),
                "text": text[:100] + ("..." if len(text) > 100 else ""),
                "status": "success"
            })
        except Exception as e:
            logger.error(f"Forwarder error: {e}")
            socketio.emit("forward_log", {
                "task_id": task_id,
                "timestamp": datetime.now().strftime("%H:%M:%S"),
                "text": f"Error forwarding message: {e}",
                "status": "error"
            })

    # Register the handler
    client.add_event_handler(handler, events.NewMessage(chats=source_entity))
    
    forwarding_tasks[task_id] = {
        "task_id": task_id,
        "phone": phone,
        "source": source,
        "target": target,
        "keywords": keywords,
        "exclude": exclude,
        "replace_find": replace_find,
        "replace_with": replace_with,
        "replace_find_2": replace_find_2,
        "replace_with_2": replace_with_2,
        "handler": handler,
        "status": "running"
    }

    return jsonify({"message": "Forwarder started", "task_id": task_id})


@app.route("/api/forwarder/stop", methods=["POST"])
def stop_forwarder():
    data = request.json
    task_id = data.get("task_id")

    if task_id not in forwarding_tasks:
        return jsonify({"error": "Task not found or already stopped"}), 404

    task = forwarding_tasks[task_id]
    phone = task["phone"]
    handler = task["handler"]

    if phone in clients:
        try:
            clients[phone].remove_event_handler(handler)
        except Exception as e:
            logger.error(f"Error removing event handler: {e}")

    del forwarding_tasks[task_id]
    return jsonify({"message": "Forwarder stopped"})


@app.route("/api/forwarder/tasks", methods=["GET"])
def list_forwarder_tasks():
    result = []
    for tid, t in forwarding_tasks.items():
        result.append({
            "task_id": t["task_id"],
            "phone": t["phone"],
            "source": t["source"],
            "target": t["target"],
            "keywords": t["keywords"],
            "exclude": t["exclude"],
            "replace_find": t.get("replace_find", ""),
            "replace_with": t.get("replace_with", ""),
            "replace_find_2": t.get("replace_find_2", ""),
            "replace_with_2": t.get("replace_with_2", ""),
            "status": t["status"]
        })
    return jsonify(result)


# ─── Group Info ───────────────────────────────────────────────────────────────

@app.route("/api/group/info", methods=["POST"])
def group_info():
    data = request.json
    phone = data.get("phone")
    group_url = data.get("group_url", "").strip()

    if phone not in clients:
        return jsonify({"error": "Account not connected"}), 400

    client = clients[phone]
    async def _get_info():
        entity = await client.get_entity(group_url)
        full = await client.get_participants(entity, limit=1)
        info = {
            "title": getattr(entity, "title", ""),
            "username": getattr(entity, "username", ""),
            "id": entity.id,
            "type": type(entity).__name__,
        }
        # Try to get member count
        try:
            from telethon.tl.functions.channels import GetFullChannelRequest
            full_ch = await client(GetFullChannelRequest(entity))
            info["members_count"] = full_ch.full_chat.participants_count
        except Exception:
            pass
        return info

    try:
        info = run_async(_get_info())
        return jsonify(info)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── SocketIO ─────────────────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    emit("connected", {"message": "Connected to TeleHarvest"})

if __name__ == "__main__":
    connect_saved_accounts()
    port = int(os.environ.get("PORT", 5080))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, use_reloader=False)
