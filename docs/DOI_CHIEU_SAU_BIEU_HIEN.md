# Đối chiếu sáu biểu hiện và khung đồ vật

Đối chiếu ngày 12/11/2026 với mục 1.3 của `Student_Attention_Bao_cao_KHKT_CapNhat.docx`.

| Biểu hiện trong báo cáo | Triển khai hiện tại | Hiển thị |
| --- | --- | --- |
| Nhắm mắt kéo dài | EAR, blendshape hai mắt và tham chiếu của từng người; xác nhận từ 1.800 ms | Khung mặt, mã học sinh và cảnh báo |
| Cầm điện thoại | YOLO11m lớp 67 + tay/cổ tay + chủ sở hữu duy nhất; xác nhận từ 800 ms | Đồng thời khung mặt và điện thoại, cùng mã học sinh; khung điện thoại đỏ khi tín hiệu đã xác nhận |
| Cúi đầu | Pitch vào từ 22°, duy trì từ 20°, xác nhận từ 2.000 ms | Vẫn công bố tín hiệu tư thế; tương tác sách/vở được xét khi tổng hợp trạng thái |
| Có thể ngáp | Độ mở miệng/jawOpen + ít nhất 1.000 ms | Khung mặt và cảnh báo |
| Có thể nói chuyện sang bên | Hiện triển khai nhãn **Có thể nói chuyện kéo dài**, ít nhất ba chu kỳ mở–đóng miệng trong cửa sổ 5 giây và thời lượng 3.000 ms | Khung mặt và cảnh báo; có sai khác với báo cáo, xem bên dưới |
| Tương tác laptop | YOLO11m lớp 63 + tay tại vùng bàn phím ước lượng; xác nhận từ 1.500 ms | Đồng thời khung mặt và laptop, cùng mã học sinh |

API vẫn trả đúng sáu phần tử `signals`: `eyes_closed`, `phone`, `head_down`, `yawn`, `talking`, `laptop`. Điểm CavT và tương tác sách là thông tin bổ sung.

## Sách/vở và tư thế học bài

YOLO11m nhận lớp `book` (73). Cần bằng chứng tay/cổ tay liên quan và chủ sở hữu duy nhất trước khi gắn sách với một học sinh. Giao diện dùng nhãn “Sách/vở”; mô hình chưa có lớp riêng cho vở học sinh và chưa có số đo độ chính xác trên tập sách/vở lớp học.

Sau ít nhất 1.000 ms tương tác sách với các mẫu cảnh mới, backend công bố `studyContext: "book"`. Tư thế cúi đầu vẫn được đo và vẫn có thể có `head_down: confirmed`, nhưng riêng tư thế này không tạo cảnh báo mới khi đã có ngữ cảnh sách/vở. Trạng thái xanh còn yêu cầu bằng chứng khuôn mặt phù hợp, mắt mở, hướng mặt hợp lệ và cửa sổ ổn định; chỉ nhìn thấy sách không làm học sinh được gán xanh. Điện thoại/laptop hoặc các cảnh báo khác vẫn được ưu tiên. Cảnh báo đã xác nhận trước đó vẫn giữ đủ thời hạn hiển thị 5 giây.

## Khung mặt và đồ vật

Luồng USB camera hiện hành trả hai danh sách độc lập: `tracks` cho mặt/học sinh và `objects` cho đồ vật. Mặt dùng mã A, B…; đồ vật dùng O1, O2… và có thể có `ownerId` nếu xác định được học sinh liên quan. Mỗi đồ vật có bbox và template VitTrack riêng. `FaceOverlay` chỉ vẽ mặt; `ObjectOverlay` chỉ vẽ đồ vật. Nhận diện đồ vật không phụ thuộc việc đã thấy mặt, thân người hoặc tay; các điều kiện đó chỉ dùng để xác nhận tương tác/hành vi.

YOLO11m phát hiện điện thoại/sách/laptop trên ảnh được gửi từ webcam. `ObjectVisualTracker` khởi tạo bằng đúng ảnh nguồn của lượt YOLO, chạy lại các ảnh đã lấy mẫu trong khoảng chờ trên luồng chuẩn bị riêng, rồi cập nhật bằng ảnh upload hiện tại. Bộ bám dùng cùng mô hình OpenCV VitTrack/ONNX Runtime như mặt; các ID, bbox và template hoàn toàn riêng. Hai loại bbox đều vẽ trên ảnh kết quả tương ứng, không nội suy tọa độ trong trình duyệt. `observedAt` vẫn là thời điểm phát hiện; `trackedAt` là thời điểm ảnh đang được bám. Bám pixel không được dùng làm bằng chứng tay hoặc gia hạn thời gian xác nhận hành vi.

Khung đồ vật là hình chữ nhật liền, ghi tên loại + ID O…; thêm mã học sinh khi có chủ sở hữu. Chưa thấy rõ tay thì ghi “Chưa rõ tương tác”, không tự tạo `phoneHeld: true` hoặc ngữ cảnh học bài. Đồ vật vẫn có bbox khi không gán được người cầm. Lượt YOLO mới không còn thấy vật, bộ bám mất tín hiệu, đổi độ phân giải hoặc quá 5 giây không được detector xác nhận sẽ bỏ bbox; cảnh báo 5 giây không giữ thêm vị trí vật. Tạm dừng/tắt camera/đổi nguồn/reset xóa cả mặt và đồ vật. Bbox lồng nhau của cùng loại và hai nhãn gần như trùng ROI được lọc để tránh vẽ trùng một vật; đây là quy tắc loại trùng, không bảo đảm mọi loại vật chồng nhau đều phân biệt được.

`/api/health` có dấu bản worker `capabilities.objectFocus: "v4-independent-vittrack"`. `trackedObjectCount` và `objectTrackingError` theo dõi bộ bám riêng. Các trường `metrics.scenePhoneCount`, `sceneBookCount`, `sceneBodyCount`, `sceneHandPointCount`, `sceneLinkedObjectCount` và `sceneInteractingObjectCount` mô tả lượt cảnh gần nhất. `sceneObjectsAt` giữ thời điểm ảnh nguồn, không đổi thành lúc xử lý xong.

Có thể chạy riêng mô hình thật trên ảnh bằng `backend/.venv/Scripts/python.exe backend/ai/probe_objects.py DUONG_DAN_ANH --output .qa/object-probe`. Công cụ dùng đúng YOLO11m ONNX, ngưỡng 0,25 của runtime và chỉ vẽ khung mô hình thực sự trả về; không mở camera. Nếu không có ảnh gốc của lần thử camera, chưa thể phân biệt chắc chắn nguyên nhân là YOLO bỏ sót, thiếu thân người, thiếu tay, dữ liệu cũ hay backend chưa nạp bản mới.

Bản v4 bám vị trí đồ vật theo từng ảnh upload giữa các lượt quét cảnh; tốc độ và độ trễ vẫn phụ thuộc máy, số vật, chuyển động, che khuất và khả năng nhận ra vật của YOLO. Chưa đo độ chính xác/độ trễ trên camera USB vật lý của người dùng.

### Lịch sử lỗi bản v3 (trước khi có bộ bám đồ vật riêng)

Đã tái hiện lỗi bằng **mô hình thật**, không gán tọa độ mô phỏng: trên ảnh `000000000328.jpg` từ [COCO128 do Ultralytics cung cấp](https://docs.ultralytics.com/datasets/detect/coco128/), YOLO11m thấy điện thoại, MediaPipe/pose gán tương tác cho người C, nhưng `objects` vẫn rỗng vì lượt cảnh mất khoảng 2.328 ms trong khi bản đầu bỏ mọi bbox quá 1.500 ms. Lượt trước sửa đã được ghi nhận trong terminal kiểm tra. `.qa/object-freshness-comparison.json` phát lại bộ lọc tuổi 1.500 ms cũ trên các phép đo thật được lưu của lượt sau sửa, đối chiếu với bbox thực tế do runtime mới công bố; đây là phép đối chiếu lại dữ liệu, không phải tệp ghi nguyên lượt trước sửa. Bản sửa dùng hạn 5 giây như bằng chứng đồ vật, kèm dấu khung cập nhật chậm. Đây không phải xác minh lại ảnh webcam người dùng vì không có tệp ảnh nguồn.

Sau sửa, `.qa/real-object-runtime.json` xác nhận `realPhoneDetected: true` và `realPhoneBoxPublished: true`, với dấu worker v3. `.qa/real-object-runtime-display.json` giữ nguyên snapshot có tọa độ thật; `.qa/real-object-runtime-ui.png` là component `FaceOverlay` thật vẽ snapshot này lên đúng ảnh nguồn, gồm ba mặt, điện thoại của C và sách của B. Bài render đạt cả kiểm tra khung điện thoại và nhãn “Cập nhật chậm”. Đây là ảnh nguồn tĩnh công khai, không phải webcam hoặc số đo độ trễ video trực tiếp.

Bài probe mô hình trên sáu ảnh công khai có phát hiện điện thoại/sách/laptop thật và cũng có trường hợp bỏ sót; không coi đây là tập đo độ chính xác độc lập. `.qa/real-model-object-probe/detections.json` giữ các dự đoán, `label-overlap.json` đối chiếu với nhãn nguồn và các tệp `*-detected.jpg` chỉ vẽ bbox thật. Ảnh `000000000328` có điện thoại và sách được phát hiện với IoU khoảng 0,921 so với từng nhãn nguồn; ảnh `000000000560` có nhãn điện thoại nhưng mô hình không trả dự đoán ở ngưỡng 0,25.

## Sai khác còn lại giữa báo cáo và phần mềm

- Báo cáo ghi nói chuyện **sang bên**, tối thiểu **1,5 giây**; mã hiện hành xác nhận chuyển động miệng kéo dài **3 giây** và không bắt buộc quay đầu ngang. Đây là sai khác đã tồn tại trước phần bổ sung đồ vật; không thể ghi rằng hai quy tắc hoàn toàn trùng nhau.
- Các mục kiến trúc trong Word còn mô tả FastAPI/WebSocket. Backend thực tế là Node.js/Express, Python worker và HTTP nhận diện theo phiên. Những chi tiết này cần được đồng bộ khi cập nhật báo cáo.

## Kiểm chứng và tái lập

- Backend: `npm --prefix backend test`; kiểm tra ngưỡng sáu tín hiệu, cảnh báo 5 giây, ngữ cảnh sách, dữ liệu lặp/cũ, khung sai tọa độ và gán chủ sở hữu không rõ ràng.
- Frontend: `npm --prefix frontend test`, `npm --prefix frontend run typecheck` và `npm --prefix frontend run build`.
- Mô hình thật qua API webcam USB: `npm --prefix backend run verify:objects`. Bài dùng ảnh công khai và nhãn nguồn, điện thoại/sách di chuyển ngược chiều trong 25 ảnh, kiểm tra ID riêng, sai số tâm/IoU, mặt cố định, đồ vật còn khi mất mặt và xóa khi vật rời ảnh. Không gọi route Pi.
- Trình duyệt với mô hình thật: build backend trước, rồi `npm --prefix frontend run test:usb-objects`. Bài thay `getUserMedia` bằng canvas ảnh công khai, dùng toàn bộ mã capture/upload webcam thật; kiểm tra pixel đánh dấu trong ảnh kết quả đang vẽ để so bbox đúng ảnh, hai lớp SVG riêng, ID ổn định, pause/resume/tắt camera và phóng to mobile. Không truy cập camera vật lý.
- `npm --prefix frontend run test:objects` là bài tín hiệu/hiển thị dùng phép đo tổng hợp; không thay thế bài mô hình thật phía trên.
- Bằng chứng hiện hành: `.qa/usb-object-tracking.json`, `.qa/usb-object-tracking-browser.json`, `.qa/usb-object-tracking-browser.png`, `.qa/usb-object-tracking-mobile.png`. `.qa/object-focus-*` giữ bài tổng hợp/hồ sơ bản trước.

Cần khởi động lại backend để Python worker nạp mã mới, sau đó tải lại trang.

Kết quả bản v4 ngày 12/11/2026: 147 kiểm thử backend TypeScript, 98 Python AI và 103 frontend đạt; TypeScript/build hai ứng dụng đạt. Bài mô hình thật `verify:objects` giữ ID riêng trong 25 khung, sai số tâm lớn nhất khoảng 8,64 px và IoU nhỏ nhất khoảng 0,732 so với nhãn nguồn được biến đổi độc lập trên ảnh 640×480. Bài Chrome `test:usb-objects` kiểm tra bảy vị trí/chiều chuyển động, sai số tâm bbox lớn nhất khoảng 8,08 px theo pixel của ảnh kết quả đang vẽ; lớp mặt/đồ vật riêng, không gọi route nhận diện Pi, pause/resume/tắt camera và phóng to mobile đạt. Các con số là kết quả fixture công khai chuyển động có kiểm soát, không phải độ chính xác camera USB thật hoặc toàn bộ 40 học sinh.

Hồ sơ bản trước: 144 kiểm thử backend TypeScript, 93 Python AI và 101 frontend đạt; bài tổng hợp `test:objects` đã kiểm tra sáu kịch bản tín hiệu, ngữ cảnh sách và cảnh báo. Có lượt chạy đồng thời thiếu bộ nhớ; không dùng lượt thiếu bộ nhớ làm bằng chứng đạt.
