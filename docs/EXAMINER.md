# Student Attention Examiner

Chạy từ thư mục gốc sau khi đã cài thư viện frontend/backend/Pi:

```powershell
cd D:\_CODE\StudentAttention
npm.cmd run examine
```

Không cần mở ứng dụng trước. Cần Chrome hoặc Edge đã cài; có thể đặt `CHROME_PATH` để chỉ định tệp trình duyệt. Mỗi bài thử chạy một lần rồi thoát. Máy chủ thử nghiệm chỉ nghe 127.0.0.1 trên cổng tạm, không chiếm 3000/3001. Không tự mở webcam, không cài dịch vụ và không dừng ứng dụng người dùng đã mở. Khi hủy bằng Ctrl+C hoặc quá hạn, runner dừng cây tiến trình kiểm thử do chính nó tạo.

## Báo cáo

- `.qa/examiner/latest.html`: báo cáo đọc bằng trình duyệt, có trạng thái và nhật ký từng nhóm.
- `.qa/examiner/latest.json`: kết quả có cấu trúc, thời gian chạy, lý do thất bại/bỏ qua.
- `.qa/examiner/system.json`: từng tình huống HTTP và trình duyệt.
- `.qa/examiner/desktop.png`, `mobile.png`: ảnh giao diện với 40 đối tượng mô phỏng.
- `.qa/examiner/dense-*.png`: 40 điểm chồng nhau được giãn trên desktop/điện thoại; bốn vùng sơ đồ.
- `.qa/rendering-load.json`: nhịp vẽ trình duyệt cho 10/20/40 track mô phỏng, tách biệt FPS suy luận AI.
- `.qa/examiner/01.log`…: đầu ra đầy đủ của từng lệnh. Khi có lỗi trình duyệt, có thêm `failure.png`.

Mã thoát 0 khi các nhóm đã chạy đều qua; 1 khi có lỗi; 130 khi người dùng hủy. Bài không chạy được ghi skipped cùng lý do, không được tính là qua. Báo cáo/ảnh của lượt hiện tại thay thế lượt trước. Không chạy hai examiner đồng thời vào cùng thư mục báo cáo.

## Phạm vi mặc định

| Nhóm | Nội dung |
| --- | --- |
| TypeScript/build | Kiểm tra và build frontend/backend bằng mã hiện tại |
| Hồi quy | Vòng đời camera, kết quả đến muộn, tracker, sáu luật trạng thái, runtime, cache mô hình, Pi agent |
| Health/proxy | Backend vắng mặt, đang nạp, sẵn sàng, lỗi; proxy giữ đúng mã phản hồi |
| Camera Chrome | StrictMode/Fast Refresh, bật/tắt nhiều lần, từ chối quyền, camera bận, cấu hình không hỗ trợ, hủy rồi mở lại |
| HTTP thật | Sai Content-Type, ảnh trống/hỏng, vượt 4 MB, kiểu mã hóa không hỗ trợ, API không tồn tại, AI chưa sẵn sàng |
| Phiên | Hai khung đồng thời trả 409; xóa phiên trong khi xử lý trả 410; phiên không tồn tại trả 404; lỗi mô hình không giữ khóa busy |
| Raspberry Pi | Nguồn vắng mặt, token sai độ dài/đúng độ dài, JPEG hỏng/hợp lệ |
| React ↔ Express | Tạo JPEG, gán ID, đổi tên/hủy sửa, tạm dừng/tiếp tục, HTTP 503, dữ liệu backend sai cấu trúc, đặt lại/tắt khi suy luận chưa xong |
| Giao diện | 10/20/40 điểm và nhịp vẽ; bốn vùng, giãn 40 điểm bị chồng; tọa độ/resize desktop/mobile, không tràn ngang, nội dung ẩn không nhận focus, giảm chuyển động |

Bài liên thông dùng Express, proxy Vite, tracker và bộ luật thật. Mô hình AI được thay bằng nguồn số đo có kiểm soát để tạo lỗi có thể lặp lại. Video canvas thay toàn bộ mediaDevices trước khi React tải; không enumerate hoặc mở webcam thật. Kiểm tra này xác minh kết nối và xử lý lỗi, không đo độ chính xác mô hình.

Nếu đã có backend tại localhost:3001, examiner chỉ đọc `/api/health` và ghi trạng thái quan sát được. Nếu chưa chạy, bài này được bỏ qua; các kiểm tra server tạm vẫn chạy. Đặt `EXAMINER_BACKEND_URL` nếu cần kiểm tra health ở địa chỉ khác; khi đã chỉ định mà không truy cập được, bài đó được đánh dấu thất bại.

## Kiểm tra AI thật bổ sung

```powershell
npm.cmd run examine -- --ai
```

Tùy chọn này chạy thêm unittest Python native và smoke test mô hình local bằng ảnh mẫu, gồm chuỗi CavT; không mở webcam. Cần backend/.venv, các tệp mô hình đã chuẩn bị và đủ bộ nhớ để nạp thêm mô hình kiểm thử. Khi thiếu mô hình, Python hoặc bộ nhớ, nhật ký ghi lỗi cụ thể; không tự bỏ qua để báo xanh. Kiểm tra này có thể mất nhiều thời gian hơn bộ mặc định.

Chưa có bộ video lớp học gán nhãn để tính precision/recall/F1, độ chính xác sáu hành động, tầm xa theo mét hoặc FPS phân tích đầy đủ 40 học sinh thật.

## Kết quả lượt triển khai examiner

11 nhóm qua, 0 thất bại, 1 bỏ qua (mô hình native tùy chọn). Có 51 kiểm thử frontend, 59 TypeScript backend, 3 Pi agent và 13 nhóm tình huống HTTP/trình duyệt. Chrome kiểm tra camera đã giải phóng đủ 13/13 luồng mô phỏng. TypeScript/build hai phía đều qua; backend đang chạy báo modelReady=true. Không chạy lại mô hình AI nặng trong lượt này.

Đã sửa các lỗi được tái hiện: giữ phiên cũ sau HTTP 503; đọc lỗi JSON null làm mất HTTP status; dữ liệu tracks sai cấu trúc/tọa độ đi tới renderer; kiểu mã hóa ảnh không hỗ trợ bị trả nhầm 500. Khởi động lại frontend/backend để dùng bản mới.

## Kiểm tra Pi sau tích hợp RTSP

Examiner chạy hồi quy Python camera agent: mặc định tắt, heartbeat/lease, phục hồi, xác thực và poweroff mô phỏng; kiểm tra API điều khiển loopback và giao diện Pi trên thiết bị mô phỏng. Có kiểm tra MJPEG qua proxy, bật/tắt camera, nhận diện và hủy/xác nhận tắt Pi. Examiner mặc định không truy cập Pi thật hay gọi poweroff thật.

Kiểm thử vật lý riêng: `node frontend/scripts/pi-live-check.mjs` dùng webcam và AI thật, ngắt heartbeat, dừng/mở backend rồi tự đóng tiến trình; không ghi webcam ra đĩa. Báo cáo `.qa/pi-live.json`.

Chỉ sau khi hoàn tất công việc trên Pi: `node frontend/scripts/pi-poweroff-check.mjs --confirm` kiểm thử nút web qua backend tới Pi thật và để Pi tắt. Script đóng server cục bộ trước khi kiểm tra SSH offline; báo cáo `.qa/pi-poweroff.json`. Muốn dùng lại phải rút/cắm nguồn.
