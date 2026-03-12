const { loadEnvFile } = require("./load-env");
const { createApp } = require("./app");

loadEnvFile();

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
