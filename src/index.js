'use strict';

const { buildApp } = require('./http/app');

const port = Number(process.env.PORT) || 3000;

buildApp().listen(port, () => {
  console.log(`metering-billing listening on port ${port}`);
});
