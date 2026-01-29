module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const appKey = (process.env.DROPBOX_APP_KEY || "").toString().trim();
  const redirectUri = (process.env.DROPBOX_REDIRECT_URI || "").toString().trim();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ appKey: appKey || null, redirectUri: redirectUri || null }));
};
