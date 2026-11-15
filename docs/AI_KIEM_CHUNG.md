# Đối chiếu công nghệ và kiểm chứng AI

Cập nhật 11/11/2026. Nguồn yêu cầu: [báo cáo KHKT](Student_Attention_Bao_cao_KHKT_CapNhat.docx). Mục tiêu triển khai là webcam local và lớp 10–40 học sinh; chưa có video lớp thật hoặc dữ liệu gán nhãn để chứng nhận độ chính xác/tầm xa. Các mục có ngày bên dưới giữ kết quả lịch sử tại thời điểm đo.

**Danh sách camera và thông báo kết nối (11/11/2026):** tên nguồn/trạng thái cùng một hàng. Pi và Webcam máy tính luôn có trong menu, mặc định chọn Pi. Trang quét một lần ban đầu, kể cả StrictMode; mở menu/quay lại trang không tự quét lại. Tín hiệu cắm/rút chỉ đánh dấu cần cập nhật; bấm “Làm mới danh sách” để lấy camera khả dụng. Nếu cần quyền, luồng dò được giải phóng ngay sau khi lấy danh sách, không đưa vào video/AI. Giữ nguồn đang chọn, camera đang phát và bảo vệ phản hồi cũ. Chỉ hiện popup khi không liên lạc được backend; backend phục hồi thì lỗi tự ẩn, không hiện thành công hoặc thông báo AI đang nạp. Readiness vẫn điều khiển nút nhận diện.

94 kiểm thử frontend, TypeScript/build đạt. Chrome giả lập kiểm tra quét ban đầu đúng một lần, không quét khi mở menu, camera mới chỉ thêm sau làm mới, quyền camera, chọn đúng deviceId và không dừng camera đang phát. Bố cục một hàng không tràn ở các chiều rộng 320/390/681/700/768/1024/1280 px. Bài camera dev/StrictMode thu hồi 13/13 luồng. Báo cáo `.qa/camera-discovery.json`, ảnh `.qa/camera-discovery-desktop.png`, `.qa/camera-discovery-mobile.png`; tái lập `npm --prefix frontend run test:devices`, `test:camera`. Các bài dùng camera giả lập, không mở webcam/Pi thật.

**Bản hiện tại dùng SCRFD-10G + VitTrack pretrained và cặp ảnh/kết quả đồng bộ.** Các lượt KCF/LK/JSFeat ở phần lịch sử đã được thay thế.

## Tăng nhịp xử lý và giữ bbox qua lần hụt ngắn — 11/11/2026

Native tracker tiếp tục cập nhật mỗi khung; detector bình thường quét khoảng 500 ms, khi mất bám yêu cầu lại sau 180 ms. Tile nguồn được lấy mẫu tới cạnh 640; khi có 1–8 mặt rộng từ 80 px thì thăm tile cách khoảng 1.250 ms. Nếu detector mạnh đồng thuận IoU từ 0,8 với bbox trên ảnh nguồn, tracker hiện còn bám tốt và template chưa quá 1,5 giây, chỉ cập nhật bằng chứng, giữ bbox/model đang sống. Mẫu lệch, cũ hoặc đã bị từ chối vẫn được khởi tạo lại và replay ảnh trung gian. Không thay model/trọng số hoặc thêm bộ lọc hình dạng.

Một native miss được giữ riêng bbox qua trạng thái `coasting` tối đa 250 ms từ lần bám thành công cuối. Mẫu lặp không gia hạn. Trạng thái này là `lost`, không tính đang thấy hoặc tạo xác nhận hành vi mới; hết hạn hoặc có detector âm tính mới thì bỏ khung. Frontend vẽ cùng node SVG, không nhấp nháy do xóa/tạo lại qua lần hụt ngắn. Tạm dừng/tắt camera/reset vẫn xóa ngay. JPEG upload đổi từ 90 xuống 84, giữ độ phân giải thu hình và tái sử dụng canvas. Giới hạn gửi là 30 lượt/giây với không quá 8 track, 15 khi đông hơn.

Bài trước/sau trên cùng ảnh công khai hai mặt 1920×1080, chỉ detector/VitTrack thật, giới hạn 30 lượt/giây: hai lượt 5 giây mỗi bản theo thứ tự trước–sau–sau–trước. Nhịp trung bình khoảng 18,38 → 20,54 lượt/giây (+11,8%); P95 thời gian gọi geometry khoảng 77,8–83,0 → 18,4–18,5 ms. Quét nền cao nhất trong từng lượt khoảng 933–1.009 → 513 ms. Ứng dụng chính có thể cùng dùng CPU. Đây không phải đo FPS luồng USB người dùng, HTTP/web hoặc toàn bộ sáu hành vi. Những lượt chỉ hạ tải tile nhưng chưa tối ưu tái sử dụng template không tăng FPS rõ; không dùng các lượt đó để khẳng định cải thiện. Bằng chứng `.qa/geometry-fps-comparison.json`, các bản thử được giữ riêng.

Hồi quy: 94 frontend, 139 backend, 83 Python AI đạt; TypeScript/build đạt. Model thật với JPEG chất lượng 84 giữ đủ hai mặt trong 96/96 phản hồi, 256/256 phản hồi video chính diện/nghiêng đạt. Bài gần/xa và khung nền sai qua hai API đạt. Chrome kiểm tra bbox liên tục qua trạng thái giữ ngắn, dừng/xóa khung và cảnh báo 5 giây đạt. `capabilities.faceTracking` có dấu `v4 short-miss continuity`; cần khởi động lại backend để nạp bản mới. Các bài dùng fixture/camera giả lập, không mở hoặc lưu hình camera USB/Pi của người dùng.

## Kiểm chứng bản VitTrack ban đầu — 10/11/2026

Nguồn mô hình: [SCRFD của InsightFace](https://github.com/deepinsight/insightface/tree/master/detection/scrfd), [OpenCV VitTrack và trọng số công bố](https://github.com/opencv/opencv_zoo/tree/main/models/object_tracking_vittrack). `ai/models.json` ghim trọng số SCRFD-10G 16.923.827 byte và VitTrack 714.726 byte bằng SHA-256. Worker gọi native `cv2.TrackerVit_create`. Motion + SVG vẽ hình chữ nhật liền trên ảnh kết quả tương ứng.

Bài so sánh hai tracker pretrained trên hai vùng mặt công khai, với dịch chuyển/scale biết trước, cho VitTrack IoU trung bình 0,893/0,903, khoảng 8,55/8,69 ms mỗi lượt; NanoTrack 0,821/0,774 và khoảng 13,2/13,4 ms. Đây là thí nghiệm chọn tracker trên máy này, không phải so sánh đầy đủ các model hoặc đánh giá lớp thật. SCRFD-10G ở cùng input chậm hơn 2.5G; bản thường giới hạn cạnh 640, quét lại chạy riêng. Bằng chứng `.qa/pretrained-comparison.json`.

Đã sửa ba nguyên nhân làm bbox sai: nguồn hình học đổi qua lại giữa hai detector; phép nhân bbox mới với scale đã trôi của tracker; và vẽ kết quả ảnh cũ trên video mới. Khi detector trả muộn, VitTrack khởi tạo trên ảnh nguồn rồi xử lý các ảnh trung gian thật, tối đa 12 ảnh/1,5 giây trong RAM. Bộ đệm xóa theo phiên. Ảnh tối dùng cùng tiền xử lý cho detector và tracker. Frontend bỏ bộ lọc scale, bù vận tốc và tracker ảnh tự viết. Cảnh báo mất dấu chỉ giữ trên sơ đồ khi không còn hỗ trợ vị trí mặt/thân người.

| Kiểm chứng bản cuối | Kết quả và giới hạn |
| --- | --- |
| Video chính diện/nghiêng | 4 video Sheffield, 16 frame/video, bản gốc và thêm dịch chuyển/roll/scale, qua upload/Pi API: 256/256 phản hồi giữ một mặt cùng ID. Góc nghiêng từ camera bên thật của bộ dữ liệu; Pi API dùng JPEG mẫu trong RAM |
| Hai mặt khác nhau | 96/96 phản hồi giữ đủ hai mặt; bốn bài người thứ hai xuất hiện mất khoảng 559–794 ms, giữ ID người đầu. P95 phản hồi sau khởi tạo khoảng 83–104 ms; chưa phải độ trễ camera đầu-cuối |
| Dịch nhanh và gần/xa | 12 bước dịch tới 144 px mỗi API, sai lệch tâm lớn nhất 6,67/8,67 px. 14 bước zoom 0,82–1,28, IoU tối thiểu khoảng 0,730/0,755 với vùng mặt đánh dấu độc lập. Sai số kích thước so với dự đoán ban đầu tối đa khoảng 15,9%/9,6%; dự đoán ban đầu không được dùng làm ground truth |
| Tối/mờ | Mỗi trường hợp 12 phản hồi: rõ, sáng hệ số 0,1, blur sigma 6 và rõ trở lại đều 2 mặt; sigma 20 còn 1 mặt. Ảnh đen/nhiễu tối không tạo người. Không suy rộng thành độ chính xác thiếu sáng thật |
| Khung nền sai | Mặt chuyển vị trí rồi rời ảnh qua hai API: vùng cũ không được coi là mặt đang thấy hoặc vẽ lại trên video |
| Ghép ảnh/bbox trên Chrome | Webcam và MJPEG Pi giả lập, thêm 220 ms HTTP có chủ đích: bbox khớp ảnh kết quả trong sai số làm tròn dưới 1 px, có nhiều ảnh kết quả mới trong lượt đo. Video hiển thị vẫn bao gồm độ trễ thu/truyền/suy luận |
| Giao diện và vòng đời | Chrome với AI thật đạt; khung chữ nhật liền, desktop/mobile, tạm dừng/tiếp tục/reset/tắt camera. Cảnh báo 5 giây giữ trên sơ đồ khi mất mặt. Bài 40 khung mô phỏng có P95 callback khoảng 16,9 ms; không phải tốc độ AI 40 mặt |
| Hồi quy và môi trường | 85 frontend, 138 backend, 81 Python AI đạt; TypeScript hai ứng dụng, build và `npm run requirement -- --check` đạt. Bài model thật xác nhận đủ sáu kênh còn mới, ID thân người và forward CavT |

Nguồn fixture, giấy phép và vùng mặt mẫu: `backend/test-fixtures/tracking/README.md`, `backend/test-fixtures/faces/README.md`. Các bài phụ thuộc bộ bám/bộ lọc đã gỡ được thay bằng kiểm chứng native model và vòng đời ghép ảnh/kết quả. Báo cáo tổng hợp `.qa/pretrained-upgrade-verification.json`; báo cáo riêng `.qa/pose-verification.json`, `.qa/tracking-motion.json`, `.qa/face-recall-verification.json`, `.qa/lowlight-verification.json`, `.qa/model-verification.json`, `.qa/ghost-verification.json`. Ảnh giao diện dùng fixture công khai: `.qa/face-bbox.png`.

Tái lập trong `backend`: `verify:poses`, `verify:faces`, `verify:tracking`, `verify:ghosts`, `verify:lowlight`, `verify:model`; trong `frontend`: `test:visual`, `test:overlay`, `test:alerts`, `test:realtime` (thêm `REALTIME_SOURCE=pi` cho MJPEG giả lập). Pi thật đã ngắt, không được bật hoặc kết nối trong lượt này. Chưa xác nhận trên webcam người dùng, không cam kết 0 ms hoặc giữ mặt khi quay hoàn toàn ra sau. Chưa đo lại thông lượng đầy đủ 40 người cho pipeline SCRFD-10G/VitTrack; các bảng tải lịch sử không đại diện bản mới.

## Công nghệ đã nối vào backend

| Công nghệ | Vai trò thực tế | Vị trí |
| --- | --- | --- |
| YOLO11s | Phát hiện người | backend/ai/perception.py |
| ByteTrack | ID thân người theo phiên | backend/ai/perception.py |
| YOLO11m | Điện thoại, laptop, sách | backend/ai/perception.py |
| YOLO11n-pose | Cổ tay hỗ trợ ghép đồ vật | backend/ai/perception.py |
| MediaPipe Hand Landmarker | Bàn tay quanh đồ vật, giới hạn số vùng/lượt | backend/ai/perception.py |
| MediaPipe Face Landmarker | EAR, miệng, blendshape, góc đầu và viền mặt | backend/ai/perception.py |
| YuNet + SCRFD-10G + OpenCV VitTrack pretrained | Tìm mặt và bám bbox bằng model có sẵn; liên hệ ID thân người khi mặt quay khuất | backend/ai/geometry.py, visual_tracking.py và scrfd.py |
| CavT DAiSEE | Điểm thô từ 8 ảnh RGB 112×112, checkpoint tác giả | backend/ai/cavt.py và cavt_worker.py |
| Motion + SVG + canvas ảnh kết quả | Viền chữ nhật liền trên đúng ảnh đã phân tích; cùng tọa độ sơ đồ, không có tracker/bộ lọc scale tự viết trên web | frontend/src/components/FaceOverlay.tsx, lib/backend-api.ts, lib/session.ts |

SCRFD-10G là nguồn bbox chính khi hai detector đồng thuận, giữ điểm neo YuNet cho hành vi. VitTrack được khởi tạo trên đúng ảnh nguồn của kết quả quét nền; tối đa 12 ảnh xử lý trong 1,5 giây được giữ trong RAM để native tracker đi qua các ảnh trung gian tới hiện tại. Không nhân bbox detector với tỷ lệ scale đã trôi của tracker trước đó. Bộ đệm này bị giới hạn theo phiên và được xóa khi đóng phiên; frontend chỉ giữ ảnh kết quả hiện hành. Ảnh thiếu sáng dùng cùng tiền xử lý tăng sáng cho detector và tracker.

YOLO11 CPU dùng tệp ONNX xuất từ đúng checkpoint đã khóa, ONNX Runtime CPU chạy mạng từ 10/11/2026, dùng chung bộ giải mã COCO/keypoint của adapter OpenCV DNN theo cùng phép letterbox và NMS theo lớp; có unit test tọa độ, lớp và cổ tay. Bản GPU dùng PyTorch. Tệp ONNX dẫn xuất có checksum local, được tạo và kiểm tra trong `npm start`. Các mục lịch sử bên dưới giữ mô tả runtime tại thời điểm đã đo.

CavT tải nghiêm ngặt đủ 232 tensor, không dùng trọng số ngẫu nhiên khi thiếu checkpoint. Checkpoint huấn luyện 1.428.986.819 byte được tách thành bản chỉ trọng số 476.350.898 byte. Trên CPU, Linear dùng dynamic INT8 để giảm bộ nhớ và thời gian; mô hình gốc vẫn được giữ. Ảnh chân dung kiểm thử cho điểm FP32 khoảng 0,79729 và INT8 khoảng 0,79970. Một ví dụ này chỉ kiểm tra sai lệch số học sơ bộ, không chứng minh độ chính xác toàn tập.

Bước căn chỉnh mặt CavT hiện dùng 5 điểm MediaPipe, không chạy OpenFace/Docker giống quy trình đánh giá của tác giả. Điểm CavT chưa được dùng làm xác suất hoặc ngưỡng tự động đổi màu. Cần hiệu chuẩn tiền xử lý và thang điểm trên dữ liệu thực trước khi dùng nó để ra quyết định.

## Sáu dấu hiệu

| Dấu hiệu | Đo và luật thời gian | Bằng chứng đã kiểm tra |
| --- | --- | --- |
| Nhắm mắt kéo dài | EAR/blink, ít nhất 1,8 giây | Unit test ngưỡng, chớp mắt ngắn, dữ liệu cũ |
| Cầm điện thoại | YOLO + tay/cổ tay + chủ duy nhất, ít nhất 0,8 giây | Luật thời gian và test gán đúng người/không rõ chủ |
| Cúi đầu | Pitch vào 22°, giữ đến 20°, ít nhất 2 giây | Unit test hysteresis và ngữ cảnh sách |
| Có thể ngáp | Miệng mở lớn/jawOpen, ít nhất 1 giây | Unit test luật thời gian |
| Có thể nói chuyện kéo dài | Chuyển động miệng ít nhất 3 giây, 3 chu kỳ trong 5 giây, không bắt buộc quay đầu | Unit test chu kỳ; quay đầu đơn thuần không chuyển đỏ |
| Tương tác laptop | Tay trong vùng bàn phím ước lượng, ít nhất 1,5 giây | Luật thời gian và test vùng tương tác; đỏ sau xác nhận theo lựa chọn ngày 10/11 |

Cả sáu được trả trong `tracks[].signals` với state clear/pending/confirmed/unavailable, nhãn và durationMs. `tracks[].observation` chứa số đo và timestamp nguồn. Mẫu có cùng timestamp không tăng thời gian xác nhận. Luồng mặt hết hạn sau 2 giây; luồng đồ vật chậm hơn trên CPU hết hạn sau 5 giây. Mất dấu, thiếu chủ đồ vật hoặc mặt dưới 48 px không đủ cơ sở đổi xanh/đỏ từ dữ liệu đó.

Từ 10/11, cả sáu dấu hiệu đã xác nhận đều chuyển đỏ, kể cả laptop và cúi đầu
có sách. Cảnh báo giữ tối thiểu 5 giây từ lần xác nhận mới nhất.
`tracks[].alerts` lưu sự kiện để hiển thị; không đổi số đo hiện tại
trong `signals`. Khi không còn xác nhận, nhãn “Vừa ghi nhận” và `held=true`
phân biệt với hành vi đang diễn ra. Mẫu lặp không gia hạn; đặt lại/tắt camera
xóa cảnh báo. Track mất mặt còn cảnh báo được giữ ở vị trí cuối với trạng thái
`lost`, nét đứt, nhãn “tạm mất dấu”; không đếm là đang thấy, không tạo bằng chứng
mới và không gán cảnh báo cũ cho người mới bước vào cùng vị trí. Hết hạn thì dọn.

Unit test kiểm tra logic ra nhãn từ số đo; ảnh chân dung kiểm tra mô hình thật và kết nối dữ liệu. Chưa có bộ video gán nhãn cho sáu hành động, nên chưa có precision/recall/F1 hoặc tỷ lệ báo nhầm đã xác nhận.

## Bài đo 10–40 mặt

Nguồn là ảnh chân dung kiểm thử TensorFlow được lặp thành lưới 1920×1080, mặt khoảng 64 px, dịch vài pixel giữa các khung. Toàn bộ mô hình được nạp và các luồng phân tích đều hoạt động. Mỗi mức tải chạy liên tục khoảng 7 giây, bao gồm khung khởi tạo; không mở webcam.

| Số mặt | Số mặt cuối bài đo | Tốc độ phản hồi đo được | P95 phản hồi sau khởi tạo |
| --- | --- | --- | --- |
| 10 | 10 | 19,76 lượt/giây | 28,01 ms |
| 20 | 20 | 18,64 lượt/giây | 35,37 ms |
| 40 | 40 | 18,28 lượt/giây | 49,51 ms |

Tệp số đo: `.qa/classroom-benchmark.json`. Script: `backend/scripts/benchmark-classroom.mjs`. Bài đo hình học riêng tại `.qa/geometry-benchmark.json` còn thử mặt 32 px; mức pixel đó chỉ dùng tìm/bám mặt, không kết luận mắt/miệng.

Bản đo cuối dùng OpenCV DNN hai luồng và CavT INT8 CPU. Luồng cảnh có độ trễ khoảng 3,4–4,4 giây trong bài này, chậm hơn luồng bám mặt; các dấu hiệu đồ vật sẽ bị vô hiệu hóa khi timestamp quá hạn 5 giây. Không phải mỗi phản hồi đều đã phân tích lại đủ sáu dấu hiệu cho mọi người.

Các số trên là tốc độ phản hồi pipeline trên máy hiện tại và ảnh tổng hợp. Không phải FPS video, FPS phân tích đầy đủ từng học sinh, tầm xa theo mét hay kết quả 40 người thật. Vẽ bbox/sơ đồ dùng rAF theo tần số màn hình, với dự đoán chuyển động tối đa 90 ms. Chuyển động thực, che khuất, kính, ánh sáng và đồ vật nhỏ có thể làm kết quả thấp hơn.

## Thử thực tế khi người dùng chủ động mở ứng dụng

1. Chạy backend và frontend bằng `npm start`; nếu đã chạy bản cũ, dừng bằng Ctrl+C rồi mở lại. Mở web, bật camera và nhận diện. Không có kiểm thử tự động nào truy cập webcam thật.
2. Kiểm tra một người gần camera: khung ôm mặt, không ôm toàn thân; di chuyển trái/phải, tiến/lùi và thay đổi kích thước cửa sổ. Bbox và điểm trên sơ đồ phải dịch cùng chiều.
3. Thử từng dấu hiệu riêng, giữ lâu hơn ngưỡng; chờ đủ các mẫu nguồn. Thử chớp mắt ngắn, quay đầu không nói, người bên cạnh dùng điện thoại và đọc sách để quan sát báo nhầm.
4. Kiểm tra API hoặc DevTools Network để xem `signals`, `reason`, `observation`, `capabilities`, `metrics`. Nếu unavailable, kiểm tra mặt/tay/đồ vật có rõ, timestamp còn mới và CPU/RAM có đủ hay không; không ép sang xanh.
5. Thêm người theo từng mức 10/20/40. Đo tại hàng gần/giữa/xa, ghi camera, độ phân giải thực, ánh sáng, góc lắp, số pixel ngang khuôn mặt và số người được phát hiện. So sánh nhãn với quan sát giáo viên để tính báo nhầm/bỏ sót.
6. Với hàng xa, ưu tiên camera có độ phân giải gốc cao, tiêu cự phù hợp và ánh sáng đủ. Có thể bật cấu hình 4K nếu webcam hỗ trợ. CPU dùng bản YOLO ONNX cố định 640; mặt nhỏ vẫn được quét riêng từ ảnh gốc. `AI_SCENE_IMGSZ` chỉ điều chỉnh nhánh PyTorch khi có GPU phù hợp; tăng độ phân giải đồ vật làm chậm nhãn.
7. Tạm dừng, đặt lại và tắt camera; kiểm tra thiết bị đã được giải phóng, mã/tên phiên cũ mất. Nhấn Ctrl+C để đóng frontend/backend.

Không cam kết 30 FPS nhận diện đủ sáu dấu hiệu cho 40 người trên CPU hiện tại. Bản này tăng chi tiết đầu vào, quét vùng mặt nhỏ và tách bám bbox khỏi các mô hình nặng. Nâng phần cứng hoặc chia camera là bước cần đánh giá bằng dữ liệu thực nếu cần tốc độ cao đồng thời cho cả lớp.


## Kết quả kiểm tra bản bàn giao

- 28 kiểm thử frontend, 39 kiểm thử TypeScript backend, 9 unittest Python và 3 kiểm thử agent Pi: **79/79 qua**.
- TypeScript và build frontend/backend: qua.
- `verify:model`: JPEG trống, ảnh chân dung chính thức, bbox mặt, ByteTrack ID, đủ sáu kênh dữ liệu có timestamp, CavT chạy chuỗi 8 ảnh và trả điểm hữu hạn; xóa phiên không tái sử dụng số đo cũ; từ chối JPEG hỏng; đóng worker: qua. Bằng chứng tại `.qa/model-verification.json` và `.qa/verify-model.log`.
- Chrome: desktop/mobile, công tắc sơ đồ, video mô phỏng đi qua AI thật, nhận diện tiếp tục hoạt động ít nhất 9 giây sau khi có điểm, không có cảnh báo lỗi, tạm dừng/tiếp tục, đặt lại và tắt camera xóa điểm: qua. Ảnh tại `.qa/desktop.png`, `.qa/face-bbox.png`, `.qa/mobile.png`.
- Chỉ dùng ảnh/video mô phỏng trong kiểm thử. Chưa kiểm chứng webcam thật, lớp 10–40 người thật, khoảng cách theo mét hoặc độ chính xác sáu hành động trên video gán nhãn.

## Sửa khởi động và kết nối — 07/11/2026

Backend mở HTTP trước khi nạp AI. Health trả `loading`, `ok` hoặc `error`; model lỗi không làm mất luôn cổng HTTP. Frontend tự thử lại kết nối, phân biệt chờ nạp với lỗi mô hình. Health qua Vite có JSON 503 khi backend chưa chạy, không in lặp stack trace kết nối từ chối.

CavT CPU hiện dùng cache INT8 `cavt_daisee_int8.pt` (~120 MB), giữ metadata của các lớp lượng tử hóa và kiểm tra checksum theo checkpoint nguồn. Cache được tạo một lần bởi setup:ai, không lượng tử hóa lại cùng lúc nạp các mô hình khác. CPU dùng cùng worker để tránh nạp Torch hai lần; OpenCV tắt bộ đệm Winograd mở rộng. Sáu quy tắc hành vi vẫn giữ nguyên.

Kiểm tra hồi quy bản này: 31 kiểm thử frontend, 44 TypeScript backend, 10 unittest Python và 3 agent Pi (**88/88 qua**). Có thêm kiểm tra round-trip cache INT8 giữ kết quả, HTTP trong lúc nạp/lỗi, tự kết nối lại, và hủy khởi động. Bộ mô hình thật vẫn được kiểm tra bằng ảnh mẫu; chưa bổ sung video lớp thật gán nhãn.

Máy có lúc chỉ còn dưới 1 GB mức bộ nhớ cấp phát khả dụng dù RAM vật lý báo còn trống. Khi thiếu bộ nhớ, health báo nguyên nhân thay vì chỉ mất kết nối; cần dừng các phiên ứng dụng cũ và đóng bớt ứng dụng đang chiếm bộ nhớ. Không tự đóng các chương trình ngoài dự án.

Lượt đo lại 10–40 mặt ngày 07/11 chưa hoàn tất vì mức bộ nhớ cấp phát của máy tiếp tục gần giới hạn; không dùng bảng tốc độ ngày 06/11 để cam kết tốc độ cho bản sửa mới. Bài kiểm tra khởi động HTTP thực tế và ảnh mẫu mô hình đã qua khi đủ bộ nhớ, cùng kiểm thử hủy khởi động và tự kết nối lại. Nhật ký bổ sung: `.qa/connection-model.log`, `.qa/startup-live.log`, `.qa/startup-cancel.log`, `.qa/connection-tests.log`.

## Điều chỉnh giảm nhãn Chưa rõ — 07/11/2026

Nhãn Tập trung nay dựa vào mắt và hướng mặt ổn định theo cửa sổ thời gian 3 giây. Không bắt buộc quan sát đầy đủ bàn tay/đồ vật cho cả sáu dấu hiệu; các tín hiệu thiếu dữ liệu vẫn được trả riêng là unavailable. Cơ chế giữ nhãn chịu được chớp mắt ngắn, quay đầu nhẹ và dao động góc quanh ngưỡng. Quay đầu đơn thuần không tạo trạng thái chờ nói chuyện; các lần quay rời rạc không được cộng chung chu kỳ miệng.

Đã qua 59 kiểm thử TypeScript backend, gồm 15 tình huống mới về mắt hơi hẹp, thiếu dữ liệu phụ, chớp mắt ở nhiều khung liên tiếp, quay nhẹ, nhìn sang lâu, nhắm mắt kéo dài, điện thoại, dữ liệu cũ và đặt lại phiên. Một chuỗi mô phỏng 8 giây chỉ gồm chớp mắt, quay nhẹ và cử động miệng nhỏ giữ xanh sau giai đoạn tích lũy ban đầu. Đây là kiểm tra logic từ số đo, chưa chứng minh tỷ lệ chính xác của camera thật.

Không hạ yêu cầu độ rõ của mặt và không chuyển xanh khi chỉ có bbox mà thiếu số đo mặt. Các cảnh báo đỏ đã đủ bằng chứng vẫn ưu tiên hơn cơ chế giữ xanh. Xem chi tiết cửa sổ và ngưỡng tại backend/README.md.

## Sửa nút camera và kiểm tra hồi quy

Đã tái hiện lỗi bấm Bật camera nhưng không gọi getUserMedia: Fast Refresh/StrictMode chạy lại cleanup của effect trong khi giữ đối tượng phiên trong state. Cleanup cũ dispose vĩnh viễn đối tượng đó. Bản sửa giải phóng camera và vô hiệu hóa yêu cầu cũ mà vẫn cho phép lần setup tiếp theo sử dụng lại. Có kiểm thử hồi quy thất bại trước bản sửa và qua sau bản sửa. Chỉnh mã điều khiển camera trong Vite sẽ tải lại toàn trang; pagehide đóng luồng hình.

Thêm xử lý phát video quá hạn 10 giây, hủy trong lúc chờ phát, thử lại cấu hình cơ bản khi driver từ chối độ phân giải/FPS và bỏ lựa chọn webcam đã rút. Lỗi quyền camera, thiết bị bận và lỗi phát hình có thông báo riêng. Kết quả đến muộn sau khi tắt camera không được mở lại phiên.

HTTP 404/410 hoặc mất kết nối backend làm phiên nhận diện cũ được hủy, xóa mã/tên và chờ người dùng bấm Tiếp tục để tạo phiên mới; không đóng camera. Health tiếp tục tự kiểm tra backend. Cache Vite và thư mục build đã được kiểm tra bằng tài khoản Windows chạy ứng dụng để tránh lặp lỗi EPERM từ tệp do tài khoản kiểm thử tạo.

Kết quả của lượt sửa này: 46 kiểm thử frontend, 59 kiểm thử TypeScript backend, TypeScript frontend và build frontend qua. Bài kiểm tra middleware Vite qua các trạng thái backend vắng mặt/đang nạp/sẵn sàng/lỗi cũng qua. Chrome chạy bản dev có StrictMode đã tạo và giải phóng đủ 13/13 luồng video mô phỏng, không có lỗi JavaScript; có kiểm tra tải lại mã điều khiển và bật camera khi backend chưa sẵn sàng. Nhật ký: `.qa/camera-dev-check.log`; ảnh: `.qa/camera-dev.png`.

Lượt kiểm tra này không truy cập webcam thật, không chạy lại các phép đo mô hình nặng hoặc chứng nhận độ chính xác sáu hành động. Máy chủ và trình duyệt thử nghiệm đều tự đóng sau khi kiểm tra; ứng dụng chỉ được người dùng mở chủ động bằng npm start.

## Cải thiện nhận diện mắt và miệng — 08/11/2026

Đối chiếu lại các mục 1.3.1, 1.3.4, 1.3.5 và 1.3.6 của báo cáo KHKT. Giữ mốc nhắm mắt 1,8 giây; ngáp 1 giây; nói chuyện sang bên cần 3 chu kỳ trong 5 giây và ít nhất 1,5 giây quan sát quay sang bên. Các thay đổi sửa cách lấy bằng chứng và chống nhiễu trước khi áp dụng thời gian, không dùng điểm CavT để lấn át cảnh báo.

- Lỗi đã tái hiện: EAR khép rõ bị blendshape chớp mắt thấp phủ quyết; ngáp/nói chuyện bị vô hiệu khi thiếu một kênh miệng; miệng hé tự nhiên không về ngưỡng khép cố định; yaw dao động sát 30° làm xóa chu kỳ; các lần mở miệng ngáp bị đếm thành nói chuyện. Trong 17 ca kiểm thử hồi quy ban đầu, 14 ca thất bại trên luật cũ và qua sau sửa.
- Mắt hiện dùng EAR riêng hai mắt, tham chiếu mắt mở của chính mã học sinh và ngưỡng vào/ra; blendshape mạnh ở cả hai mắt là bằng chứng độc lập. Tham chiếu mắt mở không hết hạn giữa lúc đang nhắm mắt để tránh học mắt nhắm thành bình thường. Chớp mắt ngắn và mắt mở hơi hẹp vẫn được kiểm tra riêng.
- Ngáp dùng được tỷ lệ miệng hoặc jawOpen đủ mạnh khi kênh kia không có dữ liệu; ngưỡng giữ thấp hơn ngưỡng vào để không xóa thời gian bởi một dao động nhỏ. Tỷ lệ hình học mở miệng không bị giới hạn như xác suất 0–1.
- Nói chuyện dùng mức miệng nghỉ theo từng người, chỉ đếm chu kỳ đã khép trên chính kênh đã mở. Quay sang bên vào từ 30°, giữ cùng bên đến 25° để chống dao động. Quay về phía trước hoặc đổi trái/phải xóa chu kỳ. Miệng đứng yên, ngáp hoặc chỉ quay đầu không đủ để kết luận nói chuyện. Nói hướng thẳng camera không thuộc dấu hiệu “nói chuyện sang bên” trong docs.
- Mắt khép từ 0,7 giây đang chờ xác nhận chuyển vàng; đủ 1,8 giây chuyển đỏ. Cảnh báo đã xác nhận luôn được xét trước nhãn Tập trung. Sau cảnh báo, cần tích lũy lại mặt ổn định; dữ liệu thiếu, mặt nhỏ hoặc kết quả cũ không được tự đổi xanh. Thông số chi tiết và cách hiệu chỉnh ban đầu nằm trong [README backend](../backend/README.md).

Kiểm chứng gồm luật theo chuỗi số đo, ưu tiên màu qua Sessions/tracker, và mô hình thật trên ảnh chân dung chính thức. Lượt mô hình thật xác nhận hai EAR riêng được truyền từ MediaPipe qua Python tới Node, EAR trung bình khớp, đủ sáu kênh tín hiệu, CavT trả điểm hữu hạn, không lỗi luồng phân tích, xóa phiên không tái dùng số đo cũ và từ chối JPEG hỏng. Tệp bằng chứng: `.qa/model-verification.json`.

Kết quả sau sửa: 82 kiểm thử TypeScript backend, 10 unittest Python và 56 kiểm thử frontend đều qua (148/148). Backend build/TypeScript và TypeScript frontend qua. Có 22 ca kiểm thử mới về mắt/miệng và một ca kiểm tra cảnh báo qua phiên nhận diện.

Đây chưa phải phép đo precision/recall của nhắm mắt, ngáp hoặc nói chuyện trên webcam thật. Cần video hành động gán nhãn theo người, kính, ánh sáng và góc quay để định lượng độ chính xác. Bài kiểm tra không truy cập camera thật.

## Lọc khung tai và đếm nói chuyện khi môi còn hé — 08/11/2026

Theo ảnh phản hồi có một mặt lớn và một khung nhỏ ở tai, bổ sung xác nhận ứng viên trước khi tạo mã học sinh. Khung YuNet dưới 0,85 hoặc khung rất nhỏ sát đầu lớn được giữ để phân tích, nhưng chỉ hiện khi có đường viền MediaPipe khớp đúng khung trong 2 giây gần nhất. Khung bộ phận nằm gần trọn trong một mặt lớn được loại dù IoU nhỏ. `facePresent` độc lập với ngưỡng 48 px của số đo hành vi, nên mặt nhỏ được xác nhận vẫn có thể theo dõi với hành vi chưa đủ dữ liệu. Không có đường viền hoặc đường viền lệch sang người bên cạnh sẽ xóa xác nhận thay vì dùng lại số đo cũ.

Nói chuyện nay đếm thêm lần giảm rõ rệt từ đỉnh mở miệng về phía mức nghỉ khi môi chưa khép hẳn. Giữ yêu cầu 3 chu kỳ trong 5 giây, cùng bên từ 1,5 giây và chu kỳ 120–1.800 ms. Dao động nhỏ quanh đỉnh, miệng hé đứng yên, mẫu lặp timestamp và ngáp vẫn không được dùng để xác nhận nói chuyện.

Kiểm chứng lượt này:

- 86 kiểm thử TypeScript backend và 23 unittest Python qua; TypeScript build qua. Trước sửa đã tái hiện hai ca bỏ sót chu kỳ miệng hé và một ca khung nhỏ lọt qua NMS.
- YuNet thật giữ đủ 10/20/40 mặt trên các ảnh lưới tổng hợp có mặt rộng 32 và 64 px; không có ứng viên nào trong các ảnh này bị bộ xác nhận mới ẩn đi. Đây không phải lớp học thật hoặc phép đo khoảng cách.
- Hai lượt `verify:model` (OpenCV 2 luồng và 1 luồng) nhận đúng một mặt trên ảnh chân dung, có `facePresent=true`, EAR riêng, số đo miệng và điểm CavT hữu hạn; không có lỗi luồng phân tích. Tuy nhiên cả hai lượt **chưa qua toàn bộ** vì luồng cảnh mất khoảng 7 giây, vượt hạn 5 giây của đồ vật, nên phone/laptop là `unavailable`. Không thay đổi hạn dữ liệu để làm bài kiểm tra qua. Tệp `.qa/model-verification.json` của lượt thành công trước không đại diện cho lượt sửa này.
- Chưa chạy lại trên webcam của người phản hồi hoặc video nói chuyện có nhãn; các ca khung tai dùng tọa độ mô phỏng theo ảnh phản hồi.

## Nhận biết chuyển động nói ở cả hướng thẳng và sang bên — 08/11/2026

Tham khảo [tài liệu chính thức về điểm mặt và thang z của MediaPipe](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/face_mesh.md), [model card Blendshapes](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf) và [Visual Voice Activity Detection của Evangelos Sariyanidi](https://github.com/sariyanidi/VoiceActivityDetection). Áp dụng việc xét chuyển động theo thời gian và chuẩn hóa hình học; không tích hợp trọng số Visual VAD/3DI, không lấy chỉ số chính xác của các nguồn làm chỉ số cho dự án.

Các điểm bỏ sót đã tái hiện trên mã cũ: nhìn thẳng luôn bị loại khỏi kênh nói; một tỷ lệ miệng hé đứng yên chặn kênh hàm đang chuyển động; cử động nhỏ hơn ngưỡng mở tuyệt đối hoặc ngắn hơn 120 ms bị bỏ qua. Có thêm lỗi tích lũy chu kỳ từ mẫu quá thưa. Sáu trong chín ca kiểm thử mới ban đầu thất bại trên mã cũ.

Bản sửa dùng tỷ lệ môi/khóe miệng 3D, giữ tỷ lệ 2D trong API để đối chiếu. Hai kênh miệng và jawOpen đếm độc lập dựa vào đáy–đỉnh cục bộ; dùng số chu kỳ lớn hơn, không cộng hai kênh. Giữ yêu cầu 3 chu kỳ trong 5 giây và ít nhất 1,5 giây quan sát; thay giới hạn tối thiểu một lần mở–giảm thành 60 ms và xóa chu kỳ khi khoảng cách mẫu vượt 750 ms. Miệng đứng yên, ngáp, nhiễu nhỏ và timestamp lặp vẫn không được dùng làm bằng chứng nói. Các biên độ 0,035/0,06 là tham số thực nghiệm, chưa hiệu chuẩn bằng video lớp học có nhãn.

Hướng thẳng nay trả tín hiệu “Có thể đang nói”, giữ vàng để giáo viên đối chiếu hoạt động học. Nói sang bên đủ bằng chứng vẫn cảnh báo đỏ. Chuyển giữa thẳng/trái/phải xóa chu kỳ, không gộp các lần quay đầu rời rạc.

Video công khai `CNN1.mp4` trong kho nghiên cứu của tác giả được tải riêng vào `.qa/speech-research` để thử luồng xử lý, không đưa vào mô hình hay gói ứng dụng. Nguồn: [video mẫu](https://github.com/sariyanidi/VoiceActivityDetection/blob/main/data/test/input/CNN1.mp4); [giấy phép kho nghiên cứu](https://github.com/sariyanidi/VoiceActivityDetection/blob/main/LICENSE), CC BY-NC-SA 4.0. Không sao chép mã nguồn hoặc trọng số từ kho này.

YuNet và MediaPipe thật lấy được 509/509 số đo hợp lệ từ video khoảng 34 giây, lấy mẫu 15 lượt/giây theo thời gian video. Mã cũ trả `talking=clear` cả 509 mẫu (yaw khoảng −10° đến +12°). Sau sửa, AttentionEvaluator trả 355 mẫu `confirmed`, 74 `pending`, 80 `clear`; đối chứng lặp một số đo mặt đứng yên với timestamp mới trả 0 mẫu `confirmed`. Các con số là số trạng thái đầu ra trên video mẫu, **không phải tỷ lệ chính xác** vì chưa có nhãn chuẩn theo từng đoạn. Nhật ký đo và kết quả: `.qa/speech-research/before.json`, `before-summary.json`, `after.json`, `after-summary.json`.

Tốc độ đo ngoại tuyến khoảng 8 mẫu/giây trên máy này, thấp hơn tốc độ lấy mẫu 15 lượt/giây theo thời gian video; bài thử không chứng minh xử lý thời gian thực ở 15 FPS hoặc lớp 40 người. Chưa truy cập webcam của người phản hồi và chưa kiểm chứng video quay nghiêng thật. Hướng dẫn chạy lại với video có sẵn nằm trong backend/README.md.

Kiểm thử: 97 ca TypeScript backend và 27 unittest Python qua, gồm kiểm tra nói thẳng/sang bên qua Sessions và tracker. Backend build qua. Mười ca frontend liên quan hợp đồng API và FaceOverlay qua; thành phần hiện có hiển thị nhãn tín hiệu đã xác nhận dưới khung mặt. Chưa chạy lại bộ `verify:model` gồm toàn bộ YOLO/CavT trong lượt sửa kênh nói này; bài đo video chỉ tải các mô hình mặt.

## Kiểm tra riêng nói khi quay mặt sang bên — 08/11/2026

Sau phản hồi xác định lỗi xảy ra lúc quay sang bên, thử hai video profile từ [Audio-Visual Lombard Grid Speech corpus của Đại học Sheffield](https://spandh.dcs.shef.ac.uk/avlombard/). Bộ dữ liệu do Najwa Alghamdi, Steve Maddock, Ricard Marxer, Jon Barker và Guy J. Brown xây dựng, giấy phép CC BY 4.0. Hai tệp mẫu `s22_p_sgbe5s2.mov` và `s16_p_bgah2n2.mov` được giữ riêng trong `.qa/speech-research/profile`, không đưa vào mô hình hay gói ứng dụng.

Đã tái hiện: YuNet tìm thấy mặt nhưng FaceLandmarker trả 0 mẫu điểm hợp lệ ở cả hai video. Thử padding và ngưỡng tìm mặt thấp hơn không khôi phục được số đo. Nhánh mới dùng [SingleFaceLandmarksDetectorGraph của chính MediaPipe 0.10.21](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/cc/vision/face_landmarker/face_landmarks_detector_graph.cc), đọc trọng số mạng điểm mặt từ tệp `.task` đã có và đưa trực tiếp vùng YuNet vào mạng. Chỉ dùng số đo khi điểm hiện diện từ 0,9 và mũi/môi/khung đều khớp với YuNet; một mesh sai gắn lên má dù điểm hiện diện cao vẫn bị loại.

Kết quả trên hai video lấy mẫu 15 lượt/giây theo thời gian video:

| Video profile | Điểm môi trước sửa | Điểm môi sau sửa | Tín hiệu nói sau sửa |
| --- | --- | --- | --- |
| `s22_p_sgbe5s2.mov` | 0/33 | 33/33 | Xác nhận từ 1.500 ms; 11 mẫu confirmed, 21 pending, 1 clear |
| `s16_p_bgah2n2.mov` | 0/34 | 0/34 | Vẫn thiếu điểm phù hợp; chưa khắc phục được trường hợp này |

Đối chứng lặp số đo profile đứng yên với timestamp mới không có mẫu confirmed. Đây là hai video mẫu ngắn trong điều kiện phòng thu có thiết bị đội đầu, không thay cho kiểm chứng camera của người phản hồi và chưa cho phép tính precision/recall. Không suy đoán nói chuyện khi nhánh profile vẫn không có điểm đạt điều kiện.

`mouthValid` và `mouthSource` tách số đo môi khỏi việc đánh giá mắt/cúi đầu/ngáp. Nhánh profile không được dùng để tạo nhãn xanh từ mắt ước lượng hoặc để xác nhận các khung nghi là tai. Lần mất điểm tối đa 250 ms tạm ngừng đầu ra nhưng giữ chu kỳ bên trong; mất lâu hơn xóa chu kỳ. Điểm neo YuNet được đưa theo chuyển động/co giãn bbox thay vì giữ tọa độ cũ trong các khung optical flow.

Backend build, 103 kiểm thử TypeScript và 34 unittest Python qua. Có kiểm tra riêng điểm môi profile, mặt nhỏ, mất điểm ngắn/dài, thay nguồn đo, mesh sai trên má và neo hình học sau chuyển động. Tệp bằng chứng mới: `male-before.json`, `male-after.json`, `male-summary.json`, `female-before.json`, `female-after.json` trong `.qa/speech-research/profile`. Chưa chạy lại bộ mô hình YOLO/CavT đầy đủ trong lượt này.

## Nhép miệng kéo dài cần chú ý, không yêu cầu quay đầu — 08/11/2026

Theo yêu cầu mới, bỏ điều kiện hướng mặt khỏi việc xác nhận và cảnh báo nói chuyện. Nhép miệng/nói có chuyển động lặp lại kéo dài mặc định từ 3 giây, ít nhất 3 chu kỳ trong cửa sổ 5 giây, chuyển Cần chú ý với nhãn “Có thể nói chuyện kéo dài”. Nói thẳng không còn được giữ vàng khi đã đủ điều kiện; thiếu góc đầu hoặc đổi hướng đầu không tự loại bằng chứng miệng. Ngưỡng 3 giây là lựa chọn mặc định của dự án, không phải ngưỡng đã hiệu chuẩn về hành vi lớp học.

Thời lượng nay tính từ chuyển động thực tế của chu kỳ đầu đến lần hoàn tất chu kỳ gần nhất, trên cùng kênh miệng hoặc hàm. Thời gian ngồi nhìn camera trước đó và thời gian chờ sau một đợt nhép ngắn không làm tăng thời lượng. Quá 1 giây không có thay đổi đủ biên độ sẽ kết thúc đợt; điều kiện mẫu mới, khoảng cách mẫu 750 ms, mất điểm 250 ms và đổi nguồn đo vẫn được kiểm tra riêng. Không cộng chu kỳ từ hai kênh hoặc ghép thời lượng kênh này với số chu kỳ kênh khác.

107 kiểm thử TypeScript backend và 34 unittest Python qua (141 ca), backend build qua. Các ca bổ sung gồm nhìn thẳng chuyển đỏ, thiếu số đo hướng đầu vẫn xét miệng, nói trong khi đổi hướng, mốc đúng 3.000 ms, ngồi nhìn lâu rồi nhép ngắn, và nhép ngắn rồi đứng yên chờ. Các kiểm tra chống báo nhầm cho miệng đứng yên, ngáp, nhiễu, mẫu cũ và mặt nhỏ vẫn qua.

Chạy lại AttentionEvaluator với số đo video thật đã lưu: video CNN1 trả 192 mẫu confirmed, 225 pending, 92 clear; đối chứng đứng yên không có confirmed. Video profile ngắn khoảng 2,2 giây vẫn có 33/33 số đo môi nhưng không đủ mốc 3 giây nên không cảnh báo (32 pending, 1 clear). Đây là kiểm tra luật mới trên số đo từ mô hình thật, chưa phải đánh giá độ chính xác trên video có nhãn hoặc webcam người dùng. Các kết quả 1,5 giây ở phần trước thuộc quy tắc cũ.

Bằng chứng: `.qa/speech-research/prolonged-speech-summary.json` và `.qa/speech-research/profile/prolonged-speech-summary.json`. Không chạy lại các mô hình YOLO/CavT vì lượt này chỉ thay quy tắc thời gian và mức cảnh báo của tín hiệu nói.

## Sửa bỏ sót hai khuôn mặt khác nhau — 09/11/2026

Phản hồi thực tế cho thấy bài lưới lặp một ảnh chân dung không bao phủ đủ lỗi
bỏ sót hai người. Đã tạo bốn cảnh JPEG 1280×720 có hai khuôn mặt khác nhau,
gồm chân dung và hai profile công khai. Nguồn, giấy phép và thao tác biến đổi
ở `backend/test-fixtures/faces/README.md`; không dùng ảnh người từ webcam làm fixture.

Tái hiện trước sửa: YuNet và SCRFD đều tìm đủ hai vùng ở cả bốn cảnh nhưng
bước bắt buộc MediaPipe xác nhận làm mất một mặt ở ba cảnh. Điểm mắt/miệng
không đo được đã bị coi thành bằng chứng không có người. Ngoài ra, adapter
trước đây không chạy SCRFD khi YuNet không có kết quả và bỏ ứng viên riêng của
mỗi detector, nên một mạng bỏ sót sẽ làm mất luôn vùng mặt của mạng kia.

| Cảnh tổng hợp hai người khác nhau | Khung hiện trước sửa | Khung hiện sau sửa |
| --- | --- | --- |
| Mặt thẳng và profile | 2/2 | 2/2 |
| Hai profile khác nhau | 1/2 | 2/2 |
| Một mặt gần, một mặt khoảng 62 px | 1/2 | 2/2 |
| Hai mặt nhỏ khoảng 55–68 px | 1/2 | 2/2 |

Hai mạng được hợp nhất thay cho giao bắt buộc. Cặp khớp IoU từ 0,3, YuNet từ
0,70 và SCRFD từ 0,65 với năm neo hợp lý được xác nhận sự hiện diện trong
1,2 giây tính từ khung detector thực sự đã đọc. Chỉ có SCRFD thì cần từ 0,75
và hai lần quét đủ mạnh liên tiếp; optical flow không tăng số lần xác nhận.
Ứng viên yếu/khung nghi là tai cạnh đầu lớn vẫn cần điểm mặt khớp. Khi hai mạng
cùng thấy mặt, giữ neo YuNet cho luật hành động hiện có. Không tải model mới,
không chạy thêm AI trên Pi, không sửa sáu luật hành vi hoặc tự đặt `valid=true`.
Lịch sử điểm mặt chỉ được cập nhật từ số đo khớp còn mới, không từ điểm detector.

Kiểm tra Pi thật còn phát hiện một mặt in ở nền đôi khi được YuNet điểm thấp
và MediaPipe cùng nhận, trong khi SCRFD không thấy và không có thân người đi
kèm. Với ứng viên **chưa đủ bằng chứng detector mạnh**, kể cả lúc một mạng có
điểm cao hoặc mesh khớp, bổ sung yêu cầu thân người được
YOLO/ByteTrack liên hệ trong dữ liệu cảnh còn mới (tối đa 5 giây). Mặt có đồng
thuận đủ mạnh vẫn hiện ngay, không chờ luồng cảnh. Điều này không phải phép
kiểm tra sống và không bảo đảm loại mọi ảnh chụp/mặt in trên màn hình.

`npm run verify:faces` trong `backend` chạy worker/model thật qua cả API upload
và `/detect/pi`: 4 cảnh × 2 đường API × 12 khung = **96/96 khung giữ đủ hai mặt**,
mỗi bên có đúng một khung và mã ổn định khi dịch ảnh 3 px. Ảnh tai, tay áo và
nền từ fixture công khai không tạo học sinh sau nhiều lần quét. Đây là kiểm tra
API Pi bằng JPEG công khai trong RAM, **chưa phải hai người trước Pi thật**.
54 kiểm thử Python và 118 kiểm thử backend đạt; `verify:model` đạt với mesh,
hai EAR, ByteTrack, CavT thật và sáu kênh tới bộ đánh giá.

Trong khung Pi thật đã kiểm tra lúc bắt đầu, người bên phải chỉ có một phần
đầu tối sát mép; cả hai detector đều không tìm được mặt đó. Một vùng tìm thấy
thứ hai ở nền không được tính là người thứ hai. Không lưu ảnh webcam xuống
đĩa. Người dùng chưa tiện thử lại hai mặt đầy đủ trong khung nên chưa xác nhận
kết quả hai người trực tiếp. Không công bố tỷ lệ chính xác lớp thật từ các bài
tổng hợp này. Bằng chứng số liệu: `.qa/two-face-before.json`,
`.qa/two-face-after.json`, `.qa/face-recall-verification.json`,
`.qa/face-recall-tests.log`, `.qa/face-fix-backend-tests.log`.

Kiểm tra lại tải sau bản sửa cuối với lưới chân dung tổng hợp như bài cũ:
khung cuối đủ 10/10, 20/20, 40/40; số mặt có điểm hợp lệ tối đa lần lượt
10, 20, 40. Nhịp phản hồi ổn định khoảng 21,42 / 20,55 / 13,98 lượt/giây;
P95 yêu cầu sau khởi tạo 35,11 / 47,98 / 103,15 ms. Khung đầu có thể chưa
hiện mặt trong lúc xác minh; đây vẫn là bài tải một chân dung lặp, không phải
đo chính xác lớp thật. Luồng cảnh ở mức 40 mất khoảng 8 giây, nên dữ liệu đồ
vật quá hạn vẫn không được dùng để kết luận. Kết quả ở
`.qa/classroom-benchmark.json`, log `.qa/face-fix-classroom-load.log`;
bản số liệu trước sửa được giữ tại `.qa/classroom-before-face-fix.json`.

Lượt Pi cuối sau bộ lọc detector/thân người: 32/32 khung không tạo học sinh từ
nền đang quan sát; `analysisError` và `geometryError` đều null. Video 1280×720
vẫn tới AI thật. Sau kiểm tra, `desired=false`, `cameraReleased=true`, Pi vẫn
kết nối và giữ cùng boot ID; không poweroff/reboot. Chỉ lưu tọa độ/số liệu tại
`.qa/pi-face-fix-final.json`, không lưu ảnh webcam. Lượt này vẫn chưa có hai
người đứng thử đầy đủ trong khung. Hai lượt trước khi siết bộ lọc được giữ
riêng trong `.qa/pi-face-fix-live-before-background-guard.json` và
`.qa/pi-face-fix-live.json`, không dùng chúng như kết quả đã loại hết nền.

## Kiểm tra tiếp lỗi người thứ hai vào chậm và backend thoát

Phát hiện điều kiện xác nhận thân người áp dụng quá rộng: ngay cả mặt lớn,
điểm detector cao và mesh đầy đủ khớp đúng vị trí cũng bị chặn nếu YOLO chưa
trả thân người, hoặc dữ liệu cảnh đã quá hạn 5 giây. Trong lượt Pi hiện tại,
độ trễ cảnh có lúc khoảng 8–12 giây. Không gia hạn dữ liệu cũ để che độ trễ.
Mặt từ 80 px, điểm detector từ 0,85, mesh đầy đủ khớp còn mới và không nghi
là bộ phận đầu bên cạnh nay không phải chờ thân người. Mặt nhỏ/yếu hoặc chỉ
có nhánh profile vẫn giữ điều kiện xác nhận hiện có. Đây không phải kiểm tra sống.

Kết nối MJPEG thiếu bộ xử lý sự kiện `error`; lỗi ghi mạng xảy ra ngoài vòng
xử lý lỗi Express có thể văng ra tiến trình Node. Đã thêm xử lý lỗi riêng cho
từng trình duyệt, bỏ kết nối lỗi và giữ kết nối khác hoạt động. Kiểm thử còn
kiểm tra lỗi đến muộn sau `close`. Hai kiểm thử mới đều thất bại trước sửa,
qua sau sửa. Tổng hồi quy: 74 frontend, 119 backend, 55 Python, 12 agent Pi;
TypeScript và build backend đạt.

Lượt Pi sau sửa: 753 phản hồi nhận diện, 187 sau tiếp tục, 184 sau đặt lại,
tổng 1.124; không có lỗi HTTP/JavaScript trong báo cáo, `analysisError` và
`geometryError` null. Backend không tự thoát trong thời gian đo. Khung hình
đối chiếu trong RAM vẫn có mặt bị cắt ở mép, người bên phải thiếu mũi/miệng;
chỉ thấy tối đa một mặt. Không dùng lượt này để chứng nhận nhận đủ hai người.
Cũng chưa tái hiện được chính xác lần tiến trình thoát về PowerShell của
người dùng: lỗi MJPEG là đường lỗi đã kiểm chứng, chưa có bằng chứng đó là
nguyên nhân duy nhất. Bộ chạy chung bổ sung tên tiến trình, mã thoát/tín hiệu;
worker AI báo lỗi/mã thoát riêng, giữ phân biệt với HTTP backend còn sống.

Bằng chứng `.qa/recheck-live-two-people.json`; các lượt trước sửa được giữ
riêng. Không lưu ảnh/video webcam. Pi giữ cùng boot ID, `desired=false`,
`cameraReleased=true` sau khi script chủ động kết thúc.

`verify:faces` với worker/model thật đạt lại 96/96 phản hồi đủ hai mặt. Bốn
bài mới bắt đầu với một mặt, đưa mặt thứ hai vào cùng phiên qua API upload/Pi:

| Fixture | API | Thấy mặt mới sau | Kiểm tra liên tiếp |
| --- | --- | --- | --- |
| Mặt thẳng + profile | upload | 648,3 ms | 8 phản hồi, giữ mã người đầu |
| Mặt thẳng + profile | Pi | 389,6 ms | 8 phản hồi, giữ mã người đầu |
| Gần + xa | upload | 268,5 ms | 8 phản hồi, giữ mã người đầu |
| Gần + xa | Pi | 400,3 ms | 8 phản hồi, giữ mã người đầu |

Nguồn là JPEG ghép từ hai khuôn mặt công khai; không mở webcam trong bài này.
Ảnh âm tính tai/tay áo/nền cũng đạt. Báo cáo tại
`.qa/face-recall-verification.json`, trường `arrivalResults`.

### Theo dõi phiên người dùng lúc 00:02 ngày 10/11/2026

Backend chính đã nạp bản sửa. Người dùng chủ động bật Pi và nhận diện; khung
đối chiếu lần này có đủ hai người. Trong tám mẫu health khi video còn phát,
số mặt lần lượt là 2, 2, 0, 0, 1, 1, 1, 1. Đã tìm được hai mặt thật nhưng
chưa giữ ổn định, vì vậy không kết luận chức năng này đã hoàn tất. Người dùng
tạm dừng nhận diện lúc 00:02:24 và tắt camera lúc 00:02:27; metrics sau đó
giữ giá trị cuối, không phải kết quả mới và không dùng tính tỷ lệ nhận diện.

AI sẵn sàng suốt 20 mẫu theo dõi, backend không tự thoát hoặc ghi lỗi stderr.
Backend được giữ chạy để tiếp tục kiểm tra; webcam tắt theo thao tác người
dùng, Pi vẫn bật. Bằng chứng `.qa/verified-backend-ready.json` và
`.qa/verified-backend-monitor-summary.json`. Không lưu ảnh/video webcam.

## Nâng bộ tìm mặt và giữ đủ sáu cảnh báo — 10/11/2026

Đổi mặc định từ SCRFD-500M sang SCRFD-2.5G KPS, giữ YuNet để kiểm tra chéo
và MediaPipe đo hành vi/xác minh ứng viên chưa chắc chắn. Tệp 3.292.009 byte
được trích riêng từ `buffalo_m.zip` ở bản phát hành `model-zoo` chính thức;
archive và model đều được khóa SHA-256 trong `backend/ai/models.json`.
Không nạp mạng nhận danh tính từ archive. Bảng WIDER FACE của tác giả cho
2.5G KPS kết quả cao hơn 500M KPS, nhưng không phải tỷ lệ chính xác ở lớp này:
[SCRFD chính thức](https://github.com/deepinsight/insightface/tree/master/detection/scrfd).

Ở bốn fixture hai mặt, thời gian riêng SCRFD trên CPU: 500M khoảng 75–77 ms,
2.5G khoảng 193–195 ms; cả hai tìm đủ hai mặt và không tìm mặt trong ba crop
âm tính tai/tay áo/nền. Dữ liệu này không đo tỷ lệ báo nhầm trên camera thật.
Quét toàn bộ tile một lượt mất khoảng 1,9 giây và làm bằng chứng mặt quá hạn;
đã chia thành toàn ảnh cộng một tile gốc luân phiên mỗi lượt nền. Lượt đầu
quét toàn ảnh; tile bổ sung chạy dần. Không kéo dài TTL để che thời gian xử lý.
Kiểm thử kiểm tra đủ sáu tile chồng lấn và giữ nguyên độ phân giải nguồn.

Ba YOLO CPU chuyển sang ONNX Runtime với đúng tệp ONNX cũ và bộ giải mã cũ.
Đối chiếu cùng tensor: sai lệch tuyệt đối lớn nhất khoảng 0,0012 ở đầu ra thô;
thời gian riêng mạng giảm khoảng hai lần trong phép đo local. `verify:model`
đạt với mesh, hai EAR, ByteTrack, CavT thật và đủ sáu kênh còn mới; luồng cảnh
khoảng 2.488 ms ở mẫu đạt. Bộ nhớ khởi tạo khoảng 681 MB, so với khoảng
1.019 MB của OpenCV DNN ở lượt trước. Các số này phụ thuộc tải máy.

Kết quả worker/model thật cuối: 96/96 phản hồi của bốn fixture qua upload/Pi
giữ hai mặt. Bốn bài thêm người thứ hai trong cùng phiên có thời gian xuất
hiện 722,5 / 477,8 / 738,7 / 511,1 ms, giữ mã người đầu và tám phản hồi liên
tiếp của mặt mới. Một lượt trước khi hoàn tất điều chỉnh có bài vào khung
không giữ đủ tám phản hồi; không dùng lượt đó làm kết quả đạt.

| Lưới tổng hợp | Khung cuối | Số mặt thấp nhất trong lượt | Nhịp phản hồi sau khởi tạo | P95 yêu cầu |
| --- | --- | --- | --- | --- |
| 10 | 10/10 | 10 | 21,32 lượt/giây | 37,10 ms |
| 20 | 19/20 | 12 | 20,95 lượt/giây | 48,23 ms |
| 40 | 40/40 | 12 | 15,39 lượt/giây | 88,07 ms |

Không diễn giải bảng thành giữ đủ mọi mặt ở mọi thời điểm hoặc phân tích đủ
sáu hành vi với nhịp trên. Đây vẫn là ảnh chân dung lặp, không phải lớp thật.

Theo lựa chọn của người dùng, **cả sáu dấu hiệu xác nhận đều đỏ**, kể cả laptop
và cúi đầu khi có sách. Không thay ngưỡng tích lũy hành vi. Giữ sự kiện trong
`alerts` tối thiểu 5 giây từ lần xác nhận mới nhất; không làm giả `signals`
hiện tại. Mẫu lặp không gia hạn. Mất mặt giữ vị trí cuối ở trạng thái `lost`,
nét đứt, nhãn “tạm mất dấu”; không đếm là đang thấy và không chuyển cảnh báo
cho người mới ở vị trí đó. Hết hạn, tắt camera hoặc đặt lại thì dọn.

Kiểm tra: 77 frontend, 129 backend, 58 Python, 12 agent Pi đạt; TypeScript và
build hai ứng dụng đạt. Chromium kiểm tra laptop đủ 1,5 giây chuyển đỏ, sau
đó số đo clear và mất mặt nhưng cảnh báo còn đủ 5 giây, rồi được xóa; không
mở webcam thật trong bài UI này. Kiểm tra ngưỡng 4.999/5.000 ms cho cả sáu
dấu hiệu, dữ liệu cũ, cùng timestamp, nhiều người và đặt lại phiên đều đạt.

Bằng chứng: `.qa/stronger-detector-comparison.json`,
`.qa/face-recall-verification.json`, `.qa/model-verification.json`,
`.qa/classroom-scrfd-2.5g.json`, `.qa/upgrade-verification.json`,
`.qa/alert-hold-browser.json` và hai ảnh UI từ video canvas. Các kết quả camera
thật trước đó không tự trở thành chứng nhận độ chính xác cho model mới.

Lượt Pi thật với bản mới: 1.030 phản hồi (624 nhận diện, 223 sau tiếp tục,
183 sau đặt lại); không ghi lỗi HTTP/JavaScript ngoài phản hồi 410 dự kiến
của yêu cầu thuộc phiên vừa đặt lại, `analysisError`/`geometryError` null.
Video RTSP/MJPEG 1280×720 hoạt động. Không có mặt được công bố trong lượt
này; số người hiện diện không được xác nhận nên không dùng làm phép đo
độ chính xác hai người hoặc tỷ lệ báo nhầm. Sau đo, Pi giữ cùng boot ID,
camera đã giải phóng và `desired=false`. Chỉ lưu số liệu tại
`.qa/pi-stronger-detector.json`; không lưu ảnh/video. Backend chính được mở
lại bằng bản mới, camera giữ tắt để người dùng chủ động thử.

## Ổn định bbox, ảnh tối/mờ và giảm tải Pi — 10/11/2026

Phần này ghi lại bản ban đầu. Điều kiện chặn theo chất lượng và bài kỳ vọng
ảnh tối không có mặt đã được thay thế trong bản tiếp tục nhận diện ảnh tối/mờ
bên dưới; các thay đổi bbox và cấu hình Pi vẫn được giữ.

Loại việc áp lại refinement tương đối từ landmark cũ lên bbox hình học mới;
đây là hai cách định nghĩa khung khác nhau, có thể làm khung đổi kích thước
qua các lượt đo. Bbox công bố nay có bộ lọc riêng cho tâm và kích thước,
chuyển động thật được đáp ứng nhanh hơn dao động nhỏ. Frontend dùng chuyển
động tâm, không coi đổi kích thước là dịch chuyển, bỏ vận tốc từ jitter nhỏ
và chặn ngoại suy ở 12% kích thước mặt. RANSAC yêu cầu ít nhất bốn inlier và
60% đồng thuận khi có mask. Giữ ID, landmark và các ngưỡng sáu hành vi.

Thêm kiểm tra chất lượng pixel ROI 64×64: độ sáng, phân vị 10–90, phương sai
Laplacian. Ảnh quá tối, ít tương phản hoặc mờ không tạo mặt mới chỉ từ điểm
detector cao; không tạo xác nhận hành vi mới. Mặt đã xác nhận chỉ giữ khung
ngắn theo bằng chứng trước đó; cảnh báo cũ vẫn có cửa sổ hiển thị 5 giây.
Các ngưỡng là mặc định kỹ thuật, chưa phải hiệu chuẩn độ chính xác lớp học.
Không tăng sáng số để coi thành chi tiết thật. `quality` và lý do chưa đủ dữ
liệu đi cùng kết quả, còn nhãn hiện tại vẫn dựa trên số đo mới.

Mô hình thật: fixture hai mặt đạt 96/96 phản hồi; kiểm tra riêng ảnh rõ,
ảnh giảm sáng còn 10%, Gaussian blur sigma 20 và ảnh rõ trở lại: 8/8 phản hồi
mỗi trường hợp cho số mặt 2 / 0 / 0 / 2. Đây là ảnh công khai bị làm suy giảm
có chủ đích, không phải phép đo camera thật trong mọi điều kiện thiếu sáng.
Lệnh `npm run verify:lowlight` hiện chạy bài thay thế ở phần tiếp tục nhận
diện ảnh tối/mờ bên dưới, không mở webcam.

Webcam Jieli thực tế chỉ công bố 25/30 FPS. Agent mới thu 1280×720/25 FPS,
lọc xuống 15 FPS trước chuyển màu/mã hóa, H264 phần cứng 4 Mbps, GOP 7;
decode/filter một luồng. Không hạ độ phân giải mặt. Máy tính tạo JPEG chất
lượng 80; frontend giới hạn 12 yêu cầu AI/giây, không xếp chồng yêu cầu.
Agent đã được sao lưu rồi cài cả bản chạy và bản bền vững qua overlayroot;
hai SHA-256 khớp mã nguồn, root trở lại `ro`, Pi giữ cùng boot ID, không reboot.

Hai phép đo FFmpeg 10 giây trên Pi, tính theo một lõi: trước 53,8%, sau
51,4%. Nhiệt độ lượt trước 46,74 → 48,20°C; lượt mới 47,71 → 47,71°C;
`get_throttled=0x0`. Chưa phải phép đo nhiệt ổn định lâu dài hoặc thí nghiệm
cùng nhiệt độ bắt đầu. Giảm tải CPU đo được còn nhỏ vì webcam vẫn phải thu
25 FPS. Không mô tả thành giảm nhiệt mạnh hoặc bảo đảm nhiệt độ về sau.

Kiểm tra: 78 frontend, 130 backend, 63 Python AI, 13 agent Pi đạt; TypeScript
và build đạt. Có kiểm tra jitter/kích thước mặt đứng yên, dịch chuyển thật,
không trộn người, ảnh tối có nhiễu, không tạo cảnh báo từ ảnh kém, và nhịp
12 yêu cầu/giây. Bài model thật vẫn đạt CavT/ByteTrack và đủ sáu kênh còn mới.
Tải lưới ảnh mẫu có khung cuối 10/10, 19/20, 40/40; không giữ đủ mặt mọi lúc.
Các số tải chạy bằng script trực tiếp không đại diện giới hạn 12 FPS trên web.

Bằng chứng bản ban đầu `.qa/lowlight-verification-before-recovery.json`, `.qa/upgrade-verification.json`,
`.qa/pi-load-before-balanced.json`, `.qa/pi-load-after-balanced.json` và
`.qa/pi-balanced-video.json`. Không lưu ảnh/video người dùng trong các phép đo.

Video MJPEG thật đo được 15,01 FPS ở 1280×720 sau khi bỏ 3 giây khởi tạo và
lấy mẫu 6 giây ổn định; agent công bố 15 FPS. Không tính các khung giải mã
dồn lúc vừa mở RTSP thành FPS ổn định. Camera đã tắt/giải phóng sau phép đo,
Pi vẫn giữ cùng boot ID và backend mới được giữ chạy để người dùng thử.

## Tiếp tục nhận diện ảnh tối/mờ — 10/11/2026

Theo phản hồi tiếp theo của người dùng, bỏ điều kiện chặn nhận diện và số
đo hành vi chỉ vì `quality.usable=false`. Chỉ số chất lượng vẫn trả về để
chẩn đoán; xác nhận mặt dựa trên hai detector hoặc landmark khớp vị trí,
các kiểm tra chống nhầm tai/thân người và timestamp hiện hành. Hành vi vẫn
cần số đo thực sự hợp lệ, đúng chủ và đủ thời gian; không suy ra hành vi
chỉ từ việc đã tìm được mặt.

Detector giữ ảnh gốc và thử thêm ảnh tăng sáng khi cần. Nâng riêng kênh L
trong LAB, giới hạn hệ số 10 và CLAHE nhẹ, không đổi tọa độ hoặc video gốc.
YuNet trên ảnh đã tăng sáng có thể đối chiếu với SCRFD trên chính khung gốc;
chỉ chạy thêm SCRFD khi bằng chứng đó chưa đủ. Cách này tránh quét lặp quá
lâu làm bằng chứng mặt hết hạn. MediaPipe thử lại ROI tăng sáng khi lần đầu
không có điểm mặt. Các lượt này không tăng số lần xác nhận theo thời gian.

`npm run verify:lowlight` kiểm tra mô hình thật với một fixture công khai,
12 phản hồi mỗi trường hợp:

| Trường hợp | Kết quả từng phản hồi |
| --- | --- |
| Ảnh rõ | 12/12 có đủ hai mặt |
| Giảm độ sáng bằng `sharp.modulate({brightness:0.1})` | 12/12 có đủ hai mặt |
| Gaussian blur sigma 6 | 12/12 có đủ hai mặt |
| Gaussian blur sigma 20 | 12/12 không công bố mặt; vẫn có chạy detector |
| Ảnh đen / nhiễu tối | 12/12 mỗi trường hợp không tạo người |
| Ảnh rõ trở lại | 12/12 có đủ hai mặt |

Đây là ảnh mẫu bị suy giảm có chủ đích, chưa phải đánh giá camera thật trong
lớp tối. Bản sửa bỏ việc tự loại mặt theo điểm chất lượng; ảnh mất quá nhiều
chi tiết vẫn có thể không đủ bằng chứng. Không hạ ngưỡng kiểm tra chéo để
buộc mô hình tạo người. Số liệu và thời gian quét được lưu tại
`.qa/lowlight-verification.json`; không lưu ảnh/video người dùng.

Hồi quy: 78 frontend, 131 backend, 68 Python AI và 13 agent Pi đạt;
TypeScript và build đạt. Kiểm tra riêng xác nhận cảnh báo vẫn dùng số đo
hợp lệ trong ảnh tối, không xác nhận từ số đo thiếu và không đếm bản tăng
sáng thành khung thời gian mới. Giữ cấu hình Pi 720p/15 FPS, giới hạn web
12 yêu cầu/giây, bbox làm mượt và cả sáu cảnh báo đỏ giữ ít nhất 5 giây.

Kiểm tra lại worker thật qua hai API upload/Pi với bốn fixture hai khuôn mặt:
96/96 phản hồi giữ đủ hai người. Bốn ca người thứ hai xuất hiện trong cùng
phiên ghi nhận sau khoảng 0,59–1,03 giây, giữ mã người đầu và tám phản hồi
liên tục sau khi thấy người mới. Ảnh tai/tay áo/nền không tạo người; bài
`verify:model` đạt mesh, CavT và sáu kênh dữ liệu còn mới. API Pi ở đây nhận
JPEG mẫu trong RAM, không thay thế đánh giá thiếu sáng với webcam Pi thật.
Bằng chứng `.qa/face-recall-verification.json`, `.qa/model-verification.json`.

## Ổn định và vẽ lại bbox trên frontend — 10/11/2026

Tiếp tục dùng React-Konva hiện có, đổi khung sang bốn góc mảnh, viền nhẹ,
nhãn nền tối một dòng và mã học sinh rõ. Nhãn thu về mã khi đông mặt;
thông tin đầy đủ vẫn có trong nội dung hỗ trợ đọc màn hình. Canvas có một
layer, không nhận sự kiện con trỏ và tắt perfect draw ở các hình đơn giản.

Thay nội suy trực tiếp cả bốn tọa độ bằng `FaceTrackPresentation`: tâm bám
nhanh, kích thước theo diện tích và tỷ lệ theo ID. Dùng tối đa năm mẫu;
thay đổi kích thước cần ít nhất ba mẫu cùng chiều và nhất quán. Tỷ lệ đổi
chậm hơn để giảm giãn ngang/dọc liên tục; một mẫu nhảy vị trí lớn chưa làm
khung lao sang chỗ khác. Vẫn thích ứng với chuyển động và khi người tiến
lại gần camera, không khóa kích thước cố định suốt phiên.

Khi mất dấu, giữ vị trí cuối tối đa 900 ms, dùng nét đứt và nhãn mất dấu;
không nâng trạng thái thành visible và không đếm là đang thấy. Kết quả
không có mẫu mới trong 650 ms cũng chuyển sang mất dấu. Mẫu trùng timestamp
không gia hạn. Khung có cảnh báo đã xác nhận vẫn được giữ tới hạn cảnh báo
riêng; không truyền cảnh báo/kích thước cho mã mới. Đặt lại phiên, đổi nguồn,
đổi độ phân giải hoặc tắt camera xóa bộ nhớ trình bày.

86 kiểm thử frontend, TypeScript và build đạt. Kiểm thử bao gồm dao động
kích thước, mẫu nhảy sai, chuyển động thật, tiến gần camera, mất dấu ngắn,
mẫu cũ, thời hạn cảnh báo và đặt lại phiên. `npm run test:overlay` chạy
Chrome thật, API phiên thật và video từ fixture công khai trong RAM, với
tọa độ điều khiển để đo riêng frontend: 120 callback với hai khung dao động
±13% chiều rộng/∓12% chiều cao giữ biên độ kích thước vẽ 0% trong lượt đo;
40 khung qua 90 callback có P95 khoảng khung 33,2 ms trong lượt cuối (lượt
trước 17 ms; lượt cuối chạy cùng kiểm thử frontend). Desktop 1440×960 và
điện thoại mô phỏng 390×844 không tràn khung; mất dấu ngắn không làm khung
biến mất và không cộng vào số người đang thấy. Không có lỗi JavaScript.

`npm run test:alerts` vẫn đạt cảnh báo laptop đỏ qua số đo clear/mất mặt
cho tới hạn 5 giây rồi xóa. Các phép đo này kiểm chứng trình bày, không
phải tỷ lệ giữ mặt đúng với camera Pi thật hoặc tốc độ suy luận 40 người.
Bằng chứng `.qa/face-overlay-verification.json`, `.qa/face-overlay-desktop.png`,
`.qa/face-overlay-mobile.png` và `.qa/alert-hold-browser.json`.


**Thay thư viện bbox và nối bám mặt/thân người (10/11/2026, sau bản Konva ở trên):** Motion + SVG thay hẳn Konva/react-konva; khung chữ nhật liền, không còn bốn góc rời hoặc nét đứt. OpenCV KCF thay LK/RANSAC và worker không làm mượt bbox lần nữa. Backend giữ ID theo thân người khi mặt quay khuất, ưu tiên mặt vừa tìm lại thay vùng suy đoán cũ để không tạo hai học sinh. Vùng suy đoán không có số đo hành vi mới; cảnh báo đỏ 5 giây vẫn giữ đúng hạn.

87 kiểm thử frontend, 134 backend, 71 Python AI, TypeScript và build đạt. Model thật qua hai API giữ đủ hai track trong 96/96 phản hồi; số này gồm bám ảnh KCF khi detector tạm bỏ sót, không phải 96 lần detector xác nhận mới. Bài dịch chuyển ảnh mẫu 48 px mỗi bước, biên dịch 144 px ở ảnh 1280×720, có 12 bước cho mỗi API: giữ ID cả hai người, không tạo track trùng; sai lệch tâm lớn nhất 10,98 px qua upload và 18,67 px qua API Pi. Đầu vào API Pi vẫn là JPEG công khai trong RAM, Pi thật đã ngắt.

Chrome kiểm tra hình chữ nhật liền, chuyển động nhanh cùng ID, tiếp tục di chuyển hơn 2 giây với dữ liệu thân người mới, reset/tắt camera và cảnh báo 5 giây đều đạt. Hai khung dao động kích thước cho biên độ vẽ 0% trong bài riêng; 40 khung có P95 khoảng callback 33,4 ms. Không có lỗi JavaScript, desktop/điện thoại mô phỏng không tràn khung. Bằng chứng hiện hành: `.qa/tracking-motion.json`, `.qa/face-recall-verification.json`, `.qa/face-overlay-verification.json`, `.qa/alert-hold-browser.json`. Các tệp overlay hiện hành đã thay kết quả của bản Konva lịch sử ở trên. Chưa có kiểm chứng người thật xoay đầu/di chuyển nhanh; mặt bị che hoàn toàn chỉ có vùng ước lượng theo thân người, không thể khẳng định bbox khít mặt thật.


Reproduce: `npm --prefix backend run verify:tracking`, `npm --prefix backend run verify:faces`, `npm --prefix frontend run test:overlay`, `npm --prefix frontend run test:alerts`.


**Xóa bbox khi tạm dừng và cập nhật gần/xa trực tiếp (10/11/2026):** tạm dừng xóa ngay tracks hiển thị, tháo overlay và xóa bộ nhớ trình bày; video vẫn phát, phản hồi về muộn không khôi phục bbox. Track có `trackingState` được vẽ đúng kích thước/tọa độ backend nhận được trong lần cập nhật đó, bỏ chờ ba mẫu, trung vị scale/tỷ lệ, nội suy và bù chuyển động ở frontend. Vì vậy phép đo biên độ vẽ 0% ở bản cũ phía trên không còn là mục tiêu của bản hiện hành: web phản ánh dữ liệu tracking mới nhất.

Đã tái hiện KCF giữ nguyên kích thước mẫu dù ảnh mặt phóng lớn. Bản mới bổ sung đo scale bằng OpenCV sparse LK thuận/ngược và RANSAC trên từng cặp ảnh, gom điểm các mặt vào cùng lượt đo; kiểm tra độ phủ điểm và điểm ngoại lai. Khi KCF trả kích thước mẫu cũ, chỉ dùng tâm của nó và giữ kích thước hiện hành. Không cộng hộp bao xoay lặp. Kiểm thử ảnh chân dung với scale từ khoảng 0,705 đến 1,504 rồi quay phẳng 20° đạt, không cần detector quét lại trong bài riêng. Bài model thật qua upload/Pi dùng JPEG mẫu có 14 bước gần/xa mỗi API (scale 0,82–1,28), giữ hai ID và kích thước sai lệch tối đa khoảng 13,45% so với bbox đầu nhân scale; đây là sai lệch theo ảnh mẫu có biến đổi đã biết, không phải nhãn bbox lớp học.

Kiểm thử frontend xác nhận xóa khi pause, bỏ kết quả muộn và đúng kích thước ngay lúc nhận. Chrome qua bài gần/xa, pause/tiếp tục, video không đóng, desktop/điện thoại và 40 khung đạt, không có lỗi JavaScript. Bài cảnh báo 5 giây vẫn đạt khi nhận diện đang chạy. Bài hồi quy model thật giữ hai track trong 96/96 phản hồi fixture, nhưng bài người thứ hai xuất hiện qua Pi API chưa đạt mốc 2,5 giây khi chạy cùng ứng dụng do người dùng mở; không kết luận đã đạt toàn bộ kiểm thử thời gian. Thời gian thu hình, AI và mạng vẫn tồn tại; chưa đo độ trễ đầu-cuối trên camera thật. Bằng chứng hiện hành `.qa/face-overlay-verification.json`, `.qa/tracking-motion.json`, `.qa/bbox-direct-verification.json`. Các tiến trình chính người dùng tự chạy được giữ nguyên; cần khởi động lại backend để worker nạp mã Python mới.



**Bám hình đang phát giữa các lượt AI (10/11/2026):** cách chỉ vẽ nguyên bbox backend vẫn chậm hơn video vì phải đợi chụp/mã hóa ảnh, HTTP và AI. Đã thêm JSFeat 0.0.8 để bám tâm/scale trên pixel đang phát ở trình duyệt cho cả webcam và MJPEG theo mục 1.2; không chạy detector/nhận danh tính hoặc phân loại hành vi trên web. Lịch sử ảnh xám chỉ giữ trong RAM và bị xóa khi tạm dừng, tắt camera, đổi nguồn hoặc đặt lại. Kết quả backend vẫn quản lý ID, sáu dấu hiệu và hạn cảnh báo; frontend không dùng chuyển động ảnh để tự xác nhận hành vi hay đếm vùng mất dấu thành mặt đang thấy.

96 kiểm thử frontend, 135 backend, TypeScript và build đạt. Unit test bao phủ video đổi vị trí/scale trong lúc chờ HTTP, đưa kết quả cũ về hiện tại, mất texture, xóa lịch sử và giữ đúng cảnh báo/ID. Chrome phát ảnh công khai chuyển động với đổi hướng, cố ý thêm 220 ms vào suy luận và đo 150 mẫu so với pixel video thực sự đang hiển thị: webcam có sai lệch tâm trung bình khoảng 6,15 px thay vì 59,31 px khi chỉ vẽ kết quả backend; MJPEG mô phỏng Pi có khoảng 11,87 px thay vì 37,40 px. Các lượt cùng tải kiểm thử khác có sai số cao hơn; số này không phải độ chính xác hoặc độ trễ đầu-cuối trên camera người thật. Nhịp callback bài 40 khung mô phỏng có P95 33,3 ms ở lượt riêng; một lượt chạy cùng hai bài Chrome khác vượt ngưỡng 50 ms. Tạm dừng xóa bbox nhưng giữ video, bài cảnh báo 5 giây và responsive đều đạt. Bằng chứng `.qa/realtime-tracking.json`, `.qa/realtime-tracking-pi.json`, `.qa/face-overlay-verification.json`, `.qa/alert-hold-browser.json`; tái lập bằng `npm --prefix frontend run test:realtime`, thêm biến môi trường `REALTIME_SOURCE=pi` để thử MJPEG mẫu. Không bật hoặc kết nối Pi thật trong các bài này.



**Sửa khung cũ bám nền sau ảnh người dùng báo (10/11/2026):** ảnh phản hồi có một người nhưng hai bbox, A nằm ở nền còn B ở mặt. Đã tái hiện bằng kiểm thử: lượt detector mới không thấy mặt nhưng điểm detector/mesh cũ vẫn cho qua; frontend cũng vẽ cả vùng `predicted`. Hai kiểm thử thất bại trước sửa và đạt sau sửa. Geometry nay ghi lượt quét bỏ sót theo timestamp, không áp lượt cũ lên track mới; bằng chứng cũ không được ghi đè kết quả âm tính mới hơn. Chỉ landmark khớp vị trí từ ảnh mới hơn mới xác nhận lại. KCF bám texture không tự gia hạn trạng thái thấy mặt. Thời gian giữ ngắn khi chưa có phủ định được tính từ lúc công bố bằng chứng mới để không rớt mặt chỉ do detector khởi tạo chậm; mẫu cũ lặp không gia hạn.

Khi đã có lượt quét âm tính, bám nền không được chặn phép dịch theo thân người. Mặt mới có thể liên hệ ngay với một body duy nhất còn mới trước khi luồng đồ vật hoàn tất; nếu có nhiều body chồng nhau thì không đoán. Vùng cũ bị bỏ khi mặt mới cùng body có hộp chồng và bằng chứng detector mạnh hơn. Cùng geometry ID không sinh ID mới chỉ vì liên kết body đổi. Web không vẽ hoặc tiếp tục optical flow cho `predicted`; cảnh báo cũ vẫn giữ trên sơ đồ theo hạn riêng.

Bài model thật dùng một mặt công khai đặt trên nền có texture, chuyển đột ngột sang vị trí khác rồi rời ảnh đạt qua API upload và API Pi dùng JPEG trong RAM: sau xác minh lại chỉ còn một khung ở mặt mới, sau rời ảnh không còn khung được coi là đang thấy. Lượt đo đầu nhận vùng cũ là `predicted` sau khoảng 574/933 ms qua hai API; vùng suy đoán không được vẽ. Đây là ảnh ghép có kiểm soát, chưa phải tái hiện mọi điều kiện webcam người dùng. Chrome xác nhận bỏ khung A bị từ chối dù ROI còn texture, vẫn vẽ B, không cộng A vào số đang thấy; P95 40 khung ở lượt này 33,4 ms. 98 frontend, 138 backend và 80 Python AI đạt; TypeScript/build đạt. Bài hồi quy hai mặt giữ 96/96 phản hồi fixture, nhưng mốc xuất hiện người thứ hai qua Pi API vẫn chưa đạt 2,5 giây trong lượt chạy cùng ứng dụng chính; không tuyên bố toàn bộ kiểm thử thời gian đạt. Bằng chứng `.qa/ghost-verification.json`, `.qa/face-overlay-verification.json`, `.qa/ghost-overlay.png`. Lệnh tái lập: `npm --prefix backend run verify:ghosts`. Backend chính tại thời điểm kiểm tra vẫn là worker cũ, cần khởi động lại để nạp mã mới; `capabilities.faceTracking` của bản sửa có dấu `negative-rescan invalidation v2`.

