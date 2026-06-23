import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      fontFamily: "system-ui, sans-serif",
      color: "#666",
    }}>
      <h1 style={{ fontSize: "4rem", margin: 0, color: "#ccc" }}>404</h1>
      <p style={{ fontSize: "1.1rem", margin: "1rem 0" }}>页面不存在</p>
      <Link
        href="/dashboard"
        style={{
          marginTop: "1rem",
          padding: "0.6rem 1.5rem",
          background: "#E5007E",
          color: "white",
          borderRadius: "6px",
          textDecoration: "none",
        }}
      >
        返回工作台
      </Link>
    </div>
  );
}
