const { loadEnvFile } = require("./load-env");
const { createApp } = require("./app");

loadEnvFile();

const app = createApp();
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}
