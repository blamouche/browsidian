const { json, getToken, getPayload, downloadText } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  const token = getToken(req);
  if (!token) return json(res, 401, { error: "Missing x-dropbox-access-token" });
  const payload = await getPayload(req);
  const path = payload.path;
  if (typeof path !== "string") return json(res, 400, { error: "Expected { path }" });

  try {
    const content = await downloadText({ token, dropboxPath: path });
    return json(res, 200, { content });
  } catch (err) {
    return json(res, 400, { error: err.message || "Dropbox error" });
  }
};
