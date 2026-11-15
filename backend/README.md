# Backend

Cài một lần tại **gốc dự án**: `npm run requirement` (thư viện Node/Python và model).

Sau đó mở terminal:

```sh
cd backend
npm start
```

Backend tự kiểm tra model, build và mở **http://localhost:3001**. Đợi “AI đã sẵn sàng”.
Pi dùng `.env` riêng theo `.env.example`; không cần cấu hình Pi khi dùng webcam máy tính.
Lịch sử lưu ở `../uploads/detection-history/`, có thể đổi bằng `HISTORY_DIR`.

[Hướng dẫn chung](../README.md) · [API và luồng xử lý](../docs/HE_THONG_HIEN_TAI.md) · [Bảo vệ RAM](../docs/PI_VA_RAM.md)
