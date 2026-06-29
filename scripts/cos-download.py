#!/usr/bin/env python3
"""Download a file from Tencent COS (via pre-signed URL) and output raw bytes to stdout."""
import sys, json, os, hmac, hashlib, time, urllib.parse, urllib.request

def generate_presigned_url(secret_id, secret_key, bucket, region, key, expires=3600):
    host = f"{bucket}.cos.{region}.myqcloud.com"
    now = int(time.time())
    expire_time = now + expires
    sign_time = f"{now};{expire_time}"
    # URL-encode the key for the HTTP path (but keep / as-is)
    encoded_key = urllib.parse.quote(key, safe='/')
    http_string = f"get\n/{encoded_key}\n\nhost={host}\n"
    string_to_sign = f"sha1\n{sign_time}\n{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    sign_key = hmac.new(secret_key.encode(), sign_time.encode(), hashlib.sha1).hexdigest()
    signature = hmac.new(sign_key.encode(), string_to_sign.encode(), hashlib.sha1).hexdigest()
    params = {
        "q-sign-algorithm": "sha1",
        "q-ak": secret_id,
        "q-sign-time": sign_time,
        "q-key-time": sign_time,
        "q-header-list": "host",
        "q-url-param-list": "",
        "q-signature": signature,
    }
    return f"https://{host}/{encoded_key}?{urllib.parse.urlencode(params)}"

if __name__ == "__main__":
    try:
        secret_id = os.environ.get("COS_SECRET_ID", "")
        secret_key = os.environ.get("COS_SECRET_KEY", "")
        bucket = os.environ.get("COS_BUCKET", "newme-1302961787")
        region = os.environ.get("COS_REGION", "ap-singapore")
        key = sys.argv[1] if len(sys.argv) > 1 else ""

        if not key:
            print(json.dumps({"error": "key is required"}), file=sys.stderr)
            sys.exit(1)

        url = generate_presigned_url(secret_id, secret_key, bucket, region, key, 300)
        
        # Download and output raw bytes to stdout
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=60) as resp:
            sys.stdout.buffer.write(resp.read())

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
