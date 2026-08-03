#!/usr/bin/env python3
"""Create COS URLs and verify or delete an object against the fixed provider."""

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_OBJECT_SIZE = 1_073_741_824


def quote(value):
    return urllib.parse.quote(str(value), safe="-_.~")


def validate_key(key):
    if not key.startswith("organizations/"):
        raise ValueError("invalid_storage_key")
    segments = key.split("/")
    if any(not segment or segment in (".", "..") for segment in segments):
        raise ValueError("invalid_storage_key")
    return key


def validate_content_md5(value):
    if not re.fullmatch(r"[A-Za-z0-9+/]{22}==", value or ""):
        raise ValueError("invalid_storage_content_md5")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("invalid_storage_content_md5") from error
    if len(decoded) != 16:
        raise ValueError("invalid_storage_content_md5")
    return value


def validate_content_type(value):
    cleaned = (value or "").strip()
    if len(cleaned) < 3 or len(cleaned) > 160 or "\n" in cleaned or "\r" in cleaned:
        raise ValueError("invalid_storage_content_type")
    return cleaned


def validate_expected_size(value):
    if value < 0 or value > MAX_OBJECT_SIZE:
        raise ValueError("invalid_storage_expected_size")
    return value


def credentials():
    secret_id = os.environ.get("COS_SECRET_ID", "").strip()
    secret_key = os.environ.get("COS_SECRET_KEY", "").strip()
    bucket = os.environ.get("COS_BUCKET", "").strip()
    region = os.environ.get("COS_REGION", "").strip()
    if not secret_id or not secret_key or not bucket or not region:
        raise ValueError("cos_credentials_required")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,127}", bucket):
        raise ValueError("invalid_cos_bucket")
    if not re.fullmatch(r"[a-z0-9-]{3,64}", region):
        raise ValueError("invalid_cos_region")
    return secret_id, secret_key, bucket, region


def canonical_headers(headers):
    normalized = {
        name.lower().strip(): " ".join(str(value).strip().split())
        for name, value in headers.items()
    }
    names = sorted(normalized)
    header_list = ";".join(quote(name) for name in names)
    header_string = "&".join(
        f"{quote(name)}={quote(normalized[name])}" for name in names
    )
    return header_list, header_string


def generate_presigned_url(key, expires=3600, method="GET", signed_headers=None):
    secret_id, secret_key, bucket, region = credentials()
    key = validate_key(key)
    if expires < 60 or expires > 3600:
        raise ValueError("invalid_cos_expiry")
    host = f"{bucket}.cos.{region}.myqcloud.com"
    now = int(time.time())
    sign_time = f"{now};{now + expires}"
    headers = {"host": host, **(signed_headers or {})}
    header_list, header_string = canonical_headers(headers)
    encoded_key = "/".join(quote(segment) for segment in key.split("/"))
    http_string = f"{method.lower()}\n/{encoded_key}\n\n{header_string}\n"
    string_to_sign = (
        f"sha1\n{sign_time}\n"
        f"{hashlib.sha1(http_string.encode('utf-8')).hexdigest()}\n"
    )
    sign_key = hmac.new(
        secret_key.encode("utf-8"), sign_time.encode("utf-8"), hashlib.sha1
    ).hexdigest()
    signature = hmac.new(
        sign_key.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1
    ).hexdigest()
    params = {
        "q-sign-algorithm": "sha1",
        "q-ak": secret_id,
        "q-sign-time": sign_time,
        "q-key-time": sign_time,
        "q-header-list": header_list,
        "q-url-param-list": "",
        "q-signature": signature,
    }
    return {
        "url": f"https://{host}/{encoded_key}?{urllib.parse.urlencode(params)}",
        "key": key,
        "method": method.upper(),
        "expires_in": expires,
    }


def create_upload(key, expires, content_type, content_md5, expected_size):
    content_type = validate_content_type(content_type)
    content_md5 = validate_content_md5(content_md5)
    expected_size = validate_expected_size(expected_size)
    content_length = str(expected_size)
    signed = generate_presigned_url(
        key,
        expires,
        "PUT",
        {
            "content-length": content_length,
            "content-md5": content_md5,
            "content-type": content_type,
            "x-cos-meta-md5": content_md5,
        },
    )
    signed["headers"] = {
        "Content-Length": content_length,
        "Content-MD5": content_md5,
        "Content-Type": content_type,
        "x-cos-meta-md5": content_md5,
    }
    return signed


def test_object_url(key):
    base = os.environ.get("COS_VERIFY_TEST_BASE_URL", "").strip()
    if not base:
        return None
    if os.environ.get("NEWME_ENVIRONMENT") != "test":
        raise ValueError("cos_test_endpoint_requires_test_environment")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("cos_test_endpoint_must_be_loopback")
    encoded_key = "/".join(quote(segment) for segment in key.split("/"))
    return f"{base.rstrip('/')}/{encoded_key}"


def verify_head(key, expected_size, expected_content_type, expected_content_md5):
    key = validate_key(key)
    if expected_size < 0 or expected_size > MAX_OBJECT_SIZE:
        raise ValueError("invalid_storage_expected_size")
    expected_content_type = validate_content_type(expected_content_type)
    expected_content_md5 = validate_content_md5(expected_content_md5)
    url = test_object_url(key)
    if url is None:
        url = generate_presigned_url(key, 300, "HEAD")["url"]
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            headers = response.headers
            size = int(headers.get("Content-Length", "-1"))
            content_type = (headers.get("Content-Type") or "").strip()
            content_md5 = (headers.get("x-cos-meta-md5") or "").strip()
            etag = (headers.get("ETag") or "").strip()
            checksum_crc64ecma = (
                headers.get("x-cos-hash-crc64ecma") or ""
            ).strip() or None
    except (urllib.error.URLError, ValueError) as error:
        raise ValueError("cos_head_failed") from error

    expected_etag = base64.b64decode(expected_content_md5).hex()
    if size != expected_size:
        raise ValueError("storage_size_mismatch")
    if content_type != expected_content_type:
        raise ValueError("storage_content_type_mismatch")
    if content_md5 != expected_content_md5:
        raise ValueError("storage_content_md5_mismatch")
    if etag.strip('"').lower() != expected_etag:
        raise ValueError("storage_etag_mismatch")
    if checksum_crc64ecma is not None and not re.fullmatch(r"[0-9]{1,20}", checksum_crc64ecma):
        raise ValueError("invalid_storage_provider_checksum")
    return {
        "key": key,
        "size": size,
        "content_type": content_type,
        "content_md5": content_md5,
        "etag": etag,
        "checksum_crc64ecma": checksum_crc64ecma,
    }


def delete_and_verify_absent(key):
    key = validate_key(key)
    test_url = test_object_url(key)
    delete_url = test_url or generate_presigned_url(key, 300, "DELETE")["url"]
    delete_status = 0
    try:
        with urllib.request.urlopen(
            urllib.request.Request(delete_url, method="DELETE"), timeout=5
        ) as response:
            delete_status = response.status
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise ValueError("cos_delete_failed") from error
        delete_status = 404
    except urllib.error.URLError as error:
        raise ValueError("cos_delete_failed") from error
    if delete_status not in (204, 404):
        raise ValueError("cos_delete_failed")

    head_url = test_url or generate_presigned_url(key, 300, "HEAD")["url"]
    try:
        with urllib.request.urlopen(
            urllib.request.Request(head_url, method="HEAD"), timeout=5
        ):
            raise ValueError("storage_object_still_exists")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise ValueError("cos_delete_absence_check_failed") from error
    except urllib.error.URLError as error:
        raise ValueError("cos_delete_absence_check_failed") from error

    return {
        "key": key,
        "absent": True,
        "delete_status": delete_status,
        "evidence": (
            "cos_delete_404_head_404"
            if delete_status == 404
            else "cos_delete_204_head_404"
        ),
    }


def main():
    args = sys.argv[1:]
    if not args:
        raise ValueError("key_required")
    if args[0] == "--put":
        if len(args) != 6:
            raise ValueError("put_arguments_required")
        result = create_upload(args[1], int(args[2]), args[3], args[4], int(args[5]))
    elif args[0] == "--head":
        if len(args) != 5:
            raise ValueError("head_arguments_required")
        result = verify_head(args[1], int(args[2]), args[3], args[4])
    elif args[0] == "--delete":
        if len(args) != 2:
            raise ValueError("delete_arguments_required")
        result = delete_and_verify_absent(args[1])
    else:
        if len(args) not in (1, 2):
            raise ValueError("get_arguments_invalid")
        result = generate_presigned_url(
            args[0], int(args[1]) if len(args) == 2 else 900, "GET"
        )
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        sys.exit(1)
