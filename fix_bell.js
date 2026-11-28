const fs = require("fs");
for (const f of ["index.html", "results.html"]) {
  if (!fs.existsSync(f)) continue;
  let h = fs.readFileSync(f, "utf8");
  h = h.replace(/<style>[\s\S]*?#resultsCenterNotifBtn[\s\S]*?<\/style>/g, "");
  h = h.replace(/<a[^>]*id=["']resultsCenterNotifBtn["'][^>]*>[\s\S]*?<\/a>/g, "");
  fs.writeFileSync(f, h, "utf8");
  console.log("تم:", f);
}
