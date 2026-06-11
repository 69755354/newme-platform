#!/usr/bin/env python3
"""COS pre-signed URL generator — GET download and PUT upload."""
import sys, json, os, hmac, hashlib, time, urllib.parse


def generate_presigned_url(secret_id, secret_key, bucket, region, key,
                           expires=3600, method="GET"):
    host = f"{bucket}.cos.{region}.myqcloud.com"
    now = int(time.time())
    expire_time = now + expires

    sign_time = f"{now};{expire_time}"

    http_method = method.upper()
    http_string = f"{http_method.lower()}\n/{key}\n\nhost={host}\n"

    string_to_sign = (
        f"sha1\n{sign_time}\n"
        f"{hashlib.sha1(http_string.encode()).hexdigest()}\n"
    )

    sign_key = hmac.new(
        secret_key.encode(), sign_time.encode(), hashlib.sha1
    ).hexdigest()
    signature = hmac.new(
        sign_key.encode(), string_to_sign.encode(), hashlib.sha1
    ).hexdigest()

    params = {
        "q-sign-algorithm": "sha1",
        "q-ak": secret_id,
        "q-sign-time": sign_time,
        "q-key-time": sign_time,
        "q-header-list": "host",
        "q-url-param-list": "",
        "q-signature": signature,
    }

    url = f"https://{host}/{key}?{urllib.parse.urlencode(params)}"

    result = {"url": url, "key": key, "method": http_method, "expires_in": expires}

    if http_method == "PUT":
        result["headers"] = {
            "Host": host,
            "Content-Type": "application/octet-stream",
        }

    return result


def main():
    secret_id = os.environ.get("COS_SECRET_ID", "")
    secret_key = os.environ.get("COS_SECRET_KEY", "")
    bucket = os.environ.get("COS_BUCKET", "newme-1302961787")
    region = os.environ.get("COS_REGION", "ap-singapore")

    # Parse args: [--method PUT|GET] <key> [expires]
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = [a for a in sys.argv[1:] if a.startswith("-")]

    method = "PUT" if "--method-put" in flags or "--put" in flags else "GET"

    if not args:
        print(json.dumps({"error": "key is required"}))
        sys.exit(1)

    key = args[0]
    expires = int(args[1]) if len(args) > 1 else 3600

    try:
        result = generate_presigned_url(
            secret_id, secret_key, bucket, region, key, expires, method
        )
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
