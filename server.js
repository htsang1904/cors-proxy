const express = require("express");
const { loadEnvFile } = require("./load-env");
const { configureApp } = require("./proxy-app");

loadEnvFile();

const app = express();
configureApp(app);
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}
