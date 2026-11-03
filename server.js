// Local static server. The game itself runs peer-to-peer in the host's browser (see public/net.js),
// so any static host works, including GitHub Pages.
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Pacmates running on http://localhost:${PORT}`));
