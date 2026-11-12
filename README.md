# 伴奏 MV 製作室

將本機影片的音訊交給 Demucs Web 分離成鼓組、低音、其他樂器及人聲，再用 FFmpeg WASM 在瀏覽器中調音量、升降 Key、套用電音效果，並把混音重新封裝回影片。音訊模型推論、影片處理都在使用者裝置執行，應用程式不會上傳媒體。

## 開始使用

需要 Node.js 20 或更新版本。

```bash
npm install
npm run dev
```

開啟 Vite 顯示的 `http://127.0.0.1:5173`。請使用 localhost 或 HTTPS；WASM 多執行緒需要 Cross-Origin Isolation。Vite 開發與預覽伺服器已設定所需的 COOP/COEP 回應標頭。GitHub Pages 不提供自訂這些回應標頭的功能，因此部署版會使用 WASM 單執行緒相容模式（或在支援時使用 WebGPU）。

正式建置與本機預覽：

```bash
npm run build
npm run preview
```

部署時，靜態主機也需回應以下標頭：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## 瀏覽器依賴

- `demucs-web/src`：基於 [timcsy/demucs-web](https://github.com/timcsy/demucs-web) 的 HTDemucs ONNX 推論程式碼。
- `onnxruntime-web`：WebGPU / WebAssembly 推論執行環境。
- `@ffmpeg/ffmpeg` 與 `@ffmpeg/core`：在瀏覽器內抽取影片音訊、封裝 MP4。
- HTDemucs ONNX 模型首次使用時，會由 Hugging Face 下載（約 172 MB）。FFmpeg WASM 核心也由 jsDelivr 載入。

使用者選取的影片不會離開瀏覽器。模型、JavaScript 套件與 FFmpeg WASM 仍須從設定的外部 CDN 下載；應用程式首次載入及使用需要網路連線。

## 裝置需求與限制

- 適合桌面版 Chrome、Edge 等支援 WebGPU 的新式瀏覽器；不支援 WebGPU 時會退回 WebAssembly。
- 建議輸入檔小於 1 GB。影片和分離音訊會在記憶體中暫存，長影片或低記憶體裝置可能無法完成。
- 預設先複製原影片影像串流，保留原畫質；若影片編碼不適合 MP4，會嘗試在瀏覽器內以 H.264 重新編碼。
- 分軌完成後可分別調整各 stem 音量、靜音/加入混音，或單獨下載 WAV。人聲預設關閉，可自行打開。
- Key 可調整 -12 到 +12 半音。混音預覽和影片輸出會套用相同設定；電音效果加入 Phaser 和 Echo。

## 授權

此移植介面與流程由本工作目錄新增。Demucs Web 原始碼依原專案 MIT License 提供，見 [LICENSE.demucs-web](./LICENSE.demucs-web)。模型及 ONNX Runtime、FFmpeg WASM 各依其上游授權條款提供。
