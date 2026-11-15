# Student Attention

Cần **Node.js 22.19+ x64** và Internet trong lần cài đầu.

**1. Cài toàn bộ thư viện, Python và model** tại thư mục gốc:

```sh
npm run requirement
```

**2. Mở hai terminal:**

```sh
cd backend
npm start
```

```sh
cd frontend
npm start
```

**3. Mở http://localhost:3000**, bật camera rồi bắt đầu nhận diện.

- Có thể dùng `npm start` ngay tại gốc để chạy cả hai cùng lúc.
- Webcam máy tính dùng ngay; Pi dùng cấu hình riêng trong `backend/.env` ([hướng dẫn Pi](Raspberry_pi_4/README.md)).
- Ảnh mặt và JSON lịch sử lưu tại `uploads/detection-history/`, không cần cơ sở dữ liệu.
- Tự giới hạn theo RAM: trần khởi điểm khoảng 20 người với 8 GB, 40 người với 16 GB; giảm theo RAM khả dụng và tăng lại khi đủ. Đây là ngân sách bảo vệ, không phải cam kết độ chính xác.
- Ctrl+C để dừng. Khi cập nhật mã, chạy lại backend và tải lại trang.

[Hệ thống hiện tại](docs/HE_THONG_HIEN_TAI.md) · [Kiểm tra](docs/EXAMINER.md) · [Bảo vệ RAM và kiểm tra Pi](docs/PI_VA_RAM.md)
