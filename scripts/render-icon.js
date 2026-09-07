const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const iconDirectory = path.join(__dirname, '..', 'assets', 'icons');
const svgPath = path.join(iconDirectory, 'nexus.svg');
const pngPath = path.join(iconDirectory, 'nexus.png');
const icoPath = path.join(iconDirectory, 'nexus.ico');

function createIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, offscreen: true }
  });
  const source = `<!doctype html><meta charset="utf-8"><style>html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(source)}`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(pngPath, image.toPNG());
  const iconPng = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  fs.writeFileSync(icoPath, createIco(iconPng));
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
