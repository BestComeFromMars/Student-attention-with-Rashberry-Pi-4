# Kiểm tra Pi và bảo vệ RAM

SSH kiểm tra ngày 15/11/2026 trên Pi hiện có: agent và MediaMTX đang chạy, `NRestarts=0`, nhiệt độ 53°C, `throttled=0x0`, RAM khả dụng khoảng 3,3 GB. Wi-Fi báo tín hiệu khoảng −37 dBm. Root và boot vẫn chỉ đọc. SHA-256 `agent.py` trên Pi khớp mã trong workspace.

Nhật ký có cảnh báo MJPEG ở lúc mở camera, pixel format cũ, miền Wi-Fi và giao diện âm thanh USB. Không thấy OOM, quá nhiệt hay sụt áp trong lần kiểm tra này. Đây là ảnh chụp trạng thái hiện tại, chưa xác định nguyên nhân lần mất kết nối trước. Các thay đổi lịch sử/ngưỡng/RAM chạy trên máy tính; không cần cài lại Pi, đổi độ phân giải hoặc thêm model vào Pi. Không thay mạng hay khởi động lại thiết bị trong lần kiểm tra.

## Ngân sách nhận diện trên máy tính

- Đọc tổng RAM và RAM khả dụng bằng `psutil`; trên Windows xét thêm bộ nhớ commit còn trống.
- Trần theo dung lượng: khoảng 20 người với 8 GB, 40 người với 16 GB; các máy khác tự nội suy, tối đa 40. Giới hạn thực tế có thể thấp hơn tùy ứng dụng đang mở.
- Dành 10% RAM cho hệ thống, tối thiểu 768 MB, tối đa 2 GB; dự toán thêm 64 MB/người. Đây là mức dự phòng, chưa phải đo đạc mọi máy hoặc mọi model tùy chọn.
- Kiểm tra lại khoảng 2 giây/lần, giảm ngay khi ngân sách thiếu. Khi đủ RAM, tăng tối đa 2 người mỗi 10 giây để tránh dao động. Giữ ít nhất một người; ưu tiên ID đã theo dõi rồi độ tin cậy của phát hiện.
- Giới hạn áp dụng trước xử lý khuôn mặt, landmark và tạo tracker thân; cắt bộ nhớ tracker dư khi giảm. Suy luận toàn ảnh vẫn tìm ứng viên để biết khi vượt giới hạn.
- Giao diện hiện **“Không đủ RAM để nhận diện.”** khi vượt khả năng hiện tại, kèm số người vẫn được xử lý. Camera và lịch sử tiếp tục; thông báo tự hết khi hết vượt mức. Bộ đếm camera dùng giới hạn hiện tại thay vì luôn ghi 40.
- Nếu cấp phát ảnh thất bại, giảm ngân sách và thử khung tiếp theo. Không thể bảo đảm chạy khi hệ điều hành không đủ RAM cho chính bộ model nền; trường hợp nạp model thất bại vẫn có thông báo lỗi riêng.

Mã: `backend/ai/memory_budget.py`, `worker.py`, `perception.py`, `person_tracking.py`. Metadata RAM đi qua API detect tới frontend. Không lấy RAM của trình duyệt hoặc của Pi làm RAM máy chạy AI.

## Chạy kiểm tra

```sh
npm --prefix backend test
npm --prefix frontend test
npm run typecheck
npm run build
npm --prefix backend run verify:startup
npm --prefix frontend run test:history
```

Các ca 8/16 GB và RAM thấp dùng số đo giả lập, không chiếm RAM thật đến mức máy treo. Giao diện webcam/Pi giả lập kiểm tra cảnh báo RAM, tiếp tục nhận diện người còn lại và phục hồi trong cùng block. Entry point production được kiểm tra với model thật, độc lập với Pi đang sử dụng.
