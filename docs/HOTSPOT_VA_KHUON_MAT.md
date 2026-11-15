# Hotspot, xác nhận khuôn mặt và trạng thái vàng

## Thay đổi

- Pi giữ mã hóa H264 phần cứng, 1280×720/30 FPS, 6 Mbps, hai luồng FFmpeg, không desktop. Không cài thêm AI hoặc thay cấu hình ghi thẻ nhớ trên Pi.
- Máy tính giải mã RTSP bằng một luồng FFmpeg (`CAP_PROP_N_THREADS=1`), TCP và tùy chọn `fflags=nobuffer`, `flags=low_delay`. Tránh độ trễ do tự động phân luồng theo khung trên H264 không có B-frame. Không hạ FPS hoặc độ phân giải.
- MJPEG chỉ gửi tiếp khi khung trước đã thoát khỏi bộ đệm ghi; khi nghẽn, bỏ các khung chờ và lấy khung mới nhất. Đóng kết nối sẽ gỡ listener. Không tạo hàng đợi 2 MB video cũ.
- JPEG do tiến trình RTSP riêng vừa giải mã/mã hóa chỉ kiểm tra metadata ở Node, tránh giải mã lặp lại bằng `sharp.stats()`. API upload JPEG vẫn kiểm tra đầy đủ dữ liệu ảnh.
- Thêm SCRFD-500M, 2.524.817 byte, kiểm tra chéo vùng mặt YuNet trong lần quét nền, không chạy trên mỗi khung video. Chỉ giữ model phát hiện, không nạp model nhận danh tính từ gói nguồn. Nguồn, hash tệp và hash archive ghim tại `backend/ai/models.json`; điều kiện trọng số nghiên cứu phi thương mại ghi trong `THIRD_PARTY_NOTICES.md`.
- Giữ box/điểm neo YuNet khi hai mạng cùng thấy mặt. Sau sửa lỗi bỏ sót hai người, ứng viên YuNet/SCRFD được hợp nhất thay vì giao bắt buộc. Bằng chứng khớp đủ mạnh có thể xác nhận sự hiện diện dù MediaPipe chưa đo được mắt/miệng; ứng viên yếu hoặc nghi là tai vẫn cần xác minh. Ứng viên riêng SCRFD phải đủ mạnh và lặp lại qua hai lần quét. Sáu bộ luật hành động và ngưỡng thời gian không đổi; không có số đo hợp lệ thì không suy ra hành vi. Chi tiết và bài kiểm tra hai người ở cuối `docs/AI_KIEM_CHUNG.md`.
- Nhãn vàng đổi thành **AI đang quan sát khuôn mặt** ở khung, sơ đồ và chú thích. Thanh điều khiển được gom nhóm trên desktop/tablet, giữ icon và dropdown trên điện thoại.

## Kiểm chứng

Phép đo trên Pi thật qua hotspot so sánh thời điểm nhận **cùng một ảnh đã giải mã** ở hai kết nối RTSP: giải mã tự chọn luồng và một luồng. Chỉ giữ CRC/timestamp trong RAM; không lưu hình camera. Lượt cuối bỏ giai đoạn khởi động ghép được **384 khung duy nhất**: một luồng nhận sớm hơn trung vị **234 ms** (P10: 219 ms; P90: 235 ms), cả hai giữ **30,00 FPS**, không đứt luồng. Đây là chênh lệch ở bộ giải mã, không phải độ trễ tổng từ cảm biến tới màn hình. Xem `.qa/pi-latency-decoder-final.json`.

Tái lập khi backend đã chạy, từ thư mục gốc:

```powershell
backend/.venv/Scripts/python.exe backend/ai/benchmark_pi_latency.py --seconds 15 --output .qa/pi-latency-decoder-final.json
```

Script khôi phục camera tắt nếu trước phép đo camera đang tắt; không tắt Pi. Hai kết nối cùng dùng TCP, biến được so sánh là số luồng giải mã.

Đã kiểm tra thêm chính tiến trình `pi_stream.py` với cấu hình FFmpeg truyền qua môi trường trước khi khởi tạo trên Windows: nhận JPEG 1280×720 liên tục, không cảnh báo native, đóng stdin thì tiến trình thoát mã 0. Camera được trả về tắt sau phép đo. Báo cáo `.qa/pi-stream-production.json` gồm cả khởi động nên không dùng FPS của nó thay cho FPS ổn định ở phép đo so sánh.

Kiểm thử model thật qua `npm run verify:model`: ảnh trống và ảnh cắt tai/tay áo/nền từ fixture công khai không tạo học sinh; ảnh chân dung có mesh đúng, CavT thực chạy, đủ sáu kênh dữ liệu. Bộ hình học vẫn tìm đủ 10/20/40 mặt ở lưới ảnh tổng hợp mặt 32 và 64 px, cập nhật bám sau lần đầu khoảng 6–12 ms trung bình trên máy đo. Lần quét đầu ảnh 1920×1080 có chia vùng mất khoảng một giây; luồng video độc lập nên không chờ lần quét này. Các ảnh lưới chỉ kiểm tra bộ tìm/bám mặt, không chứng minh mọi mặt nhỏ đều đủ landmark để xuất hiện hoặc phân tích hành vi.

Video góc nghiêng `s22_p_sgbe5s2.mov` vẫn có 33/33 số đo miệng hợp lệ khi kiểm tra chéo SCRFD; các box/điểm neo/số đo được giữ như bản trước. Các fixture không thay cho video lớp học có nhãn; chưa có tỷ lệ chính xác hoặc báo nhầm lớp thật đã xác nhận. Tai/vật ở góc hoặc ánh sáng khác vẫn cần kiểm chứng thực tế.

Các kiểm thử tự động: 114 backend, 39 Python AI, 69 frontend; build/typecheck và kịch bản web giả lập đạt, gồm chống tích hàng khung hình khi trình duyệt chậm, bbox vật có điểm cao, xác nhận sai người, dữ liệu hết hạn và profile. Responsive kiểm tra từ 320 đến 1440 px, cả ngang/dọc, không chồng hoặc tràn nút.

Khi kiểm tra model đồng thời với nhiều trình duyệt, máy từng thiếu RAM. Tiến trình đo đã được thu hồi; các kiểm chứng model được chạy riêng sau đó. SCRFD chỉ dùng một luồng, tắt idle spinning và arena/pattern lưu theo kích thước. Không chạy nhiều bài đo mô hình cùng lúc trên máy ít RAM.

## Chạy bản cập nhật

Nếu backend đang chạy bản cũ, dừng bằng Ctrl+C rồi `npm start` lại trong `backend` để nạp model và mã Node mới. Frontend dev sẽ tự cập nhật; bản đã build cần build/chạy lại. Không cần triển khai hoặc reboot Pi cho lần sửa này.

Tham khảo kỹ thuật: [cấu hình thread/capture options OpenCV 4.11](https://github.com/opencv/opencv/blob/4.11.0/modules/videoio/src/cap_ffmpeg_impl.hpp), [cờ giảm đệm của FFmpeg](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/options_table.h), [SCRFD chính thức](https://github.com/deepinsight/insightface/tree/master/detection/scrfd).
