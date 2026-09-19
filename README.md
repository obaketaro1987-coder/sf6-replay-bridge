# SF6 Replay Bridge + Auto Recorder

User Code `3032582018`（おばけたろう）の対戦履歴とOBS録画を結びつける個人用ブリッジです。

## 構成

- `/api/state`: SF6 Replay Webから最新対戦を取得
- `/api/upload`: Windows Recorder用のVercel Blobアップロード認証
- `/api/matches`: 自動録画済み試合の一覧
- `/`: 状態・対戦履歴・自動録画リンクのダッシュボード
- `recorder/`: Windowsで動かすOBS自動保存プログラム

録画開始の画面認識は使いません。OBSのリプレイバッファを待機させ、新しい対戦がCFNに追加されたら直前数分を保存します。これにより試合冒頭を含めて保存でき、画面文字の誤検知も避けられます。

## Vercel側の初回設定

1. Vercelの対象プロジェクトで `Storage` → `Create Database` → `Blob` を作成し、アクセスを `Public` にしてこのプロジェクトへ接続する。
2. Project Settings → Environment Variables に `RECORDER_API_KEY` を追加する。十分に長いランダムな文字列を使用する。
3. Productionへ再デプロイする。
4. `https://sf6-replay-bridge.vercel.app/api/upload` を開き、`configured: true` を確認する。

Blob接続時に `BLOB_READ_WRITE_TOKEN` が自動設定されます。動画は推測困難なURLを持つPublic Blobとして保存されます。これはChatGPTから動画を取得して分析できるようにするためです。

## Windows Recorderの初回設定

### OBS

1. `ツール` → `WebSocketサーバー設定` でWebSocketサーバーを有効にする（通常ポート `4455`）。
2. `設定` → `出力` → `リプレイバッファ` を有効にする。
3. 最大リプレイ時間を `300秒` にする。
4. 録画形式は `Hybrid MP4` または `Fragmented MP4` を推奨。
5. SF6を映すシーンを選んだ状態でOBSを起動しておく。

### Recorder

1. WindowsにNode.js 20以上のLTS版をインストールする。
2. `recorder/install-recorder.cmd` をダブルクリックする。
3. 作成された `recorder/config.json` を開く。
4. `recorderApiKey` にVercelへ設定したものと同じ値、`obs.password` にOBS WebSocketのパスワードを入れる。
5. `recorder/start-recorder.cmd` をダブルクリックする。

初回起動時は現在の最新試合を基準として記録し、次の試合から自動保存します。

## 動画の自動削除

`deleteAfterUpload` は初期値で `true` です。次のすべてを満たしたときだけPC上の動画を完全削除します。

1. Vercel Blobへのアップロードが完了
2. 公開URLへHEAD確認が成功
3. 取得できる場合はサーバー上のContent-Lengthが元動画と一致

送信失敗・回線切断・確認失敗時は削除しません。未完了情報を `recorder-state.json` に残し、次回起動時に自動再送します。

## 注意

- CAPCOMのIDやパスワードは保存しません。
- `config.json` と `recorder-state.json` はGit管理から除外されています。
- Public BlobはURLを知っている人が閲覧できます。対戦動画以外をOBSシーンに映さないでください。
- Blobの保存容量・転送量にはVercelプランの上限と料金が適用されます。
