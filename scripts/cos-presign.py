#!/usr/bin/env python3
"""COS pre-signed URL generator — used by CRM API route."""
import sys, json, os, hmac, hashlib, time, urllib.parse

def generate_presigned_url(secret_id, secret_key, bucket, region, key, expires=3600):
    host = f"{bucket}.cos.{region}.myqcloud.com"
    now = int(time.time())
    expire_time = now + expires
    
    sign_time = f"{now};{expire_time}"
    http_string = f"get
/{key}

host={host}
"
    string_to_sign = f"sha1
{sign_time}
{hashlib.sha1(http_string.encode()).hexdigest()}
"
    
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
    
    return f"https://{host}/{key}?{urllib.parse.urlencode(params)}"

if __name__ == "__main__":
    try:
        # Read from env
        secret_id = os.environ.get("COS_SECRET_ID", "")
        secret_key = os.environ.get("COS_SECRET_KEY", "")
        bucket = os.environ.get("COS_BUCKET", "newme-1302961787")
        region = os.environ.get("COS_REGION", "ap-singapore")
        
        key = sys.argv[1] if len(sys.argv) > 1 else ""
        expires = int(sys.argv[2]) if len(sys.argv) > 2 else 3600
        
        if not key:
            print(json.dumps({"error": "key is required"}))
            sys.exit(1)
        
        url = generate_presigned_url(secret_id, secret_key, bucket, region, key, expires)
        print(json.dumps({"url": url, "key": key, "expires_in": expires}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
