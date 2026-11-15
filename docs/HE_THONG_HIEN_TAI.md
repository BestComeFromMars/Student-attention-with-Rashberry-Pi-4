  # Student Attention — Hệ thống hiện tại

  **Ngày rà soát: 15/11/2026.** Tài liệu tổng hợp frontend, backend và luồng camera theo mã nguồn hiện có. Đây là bản mô tả hiện trạng; các đoạn mô tả lịch sử trong README hoặc báo cáo trước đây có thể khác bản này.

  ## 1. Hệ thống đang làm gì?

  Student Attention hỗ trợ giáo viên quan sát lớp học qua camera. Hệ thống tìm người, khuôn mặt và một số đồ vật; theo dõi các dấu hiệu hành vi qua nhiều khung hình; hiển thị cảnh báo và danh sách người cần chú ý.

  Hai nguồn hình được hỗ trợ:

  - Webcam gắn trực tiếp vào máy tính, được trình duyệt cấp quyền sử dụng.
  - Webcam USB trên Raspberry Pi 4, truyền hình qua mạng nội bộ về máy tính.

  Toàn bộ AI chạy ở backend trên máy tính. Raspberry Pi đảm nhiệm camera và truyền video; frontend đảm nhiệm thao tác, hiển thị và lấy khung hình gửi đi xử lý.

  Kết quả chính là **dấu hiệu quan sát được**, chẳng hạn nhắm mắt kéo dài, cầm điện thoại hoặc quay đầu. Phiên bản mặc định hiện tại không chấm điểm mức độ tập trung bằng CavT. Mã theo dõi là mã trong phiên, chưa phải nhận dạng danh tính học sinh bằng sinh trắc học.

  ## 2. Kiến trúc tổng thể

  ```mermaid
  flowchart TD
      PC[Webcam máy tính] --> WEB[Frontend React]
      USB[Webcam USB trên Pi] --> AG[Camera agent và FFmpeg]
      AG --> MT[MediaMTX: RTSP]
      MT --> READER[Worker đọc RTSP trên máy tính]
      READER --> RAM[Khung hình mới nhất trong RAM]
      RAM -->|MJPEG| WEB
      WEB -->|JPEG và frame ID| API[Backend Node.js / Express]
      API --> PIXEL[Luồng bám pixel riêng]
      API --> AI[Python: dò người, mặt, đồ vật, pose và landmark]
      AI --> RULE[Theo dõi và luật hành vi theo thời gian]
      PIXEL -->|Tọa độ đúng frame ID| WEB
      RULE -->|Nhãn, dấu hiệu và cảnh báo| WEB
      WEB --> CLIENT[DetectionHistory: hàng đợi cập nhật và thử lại]
      CLIENT --> HIST[API lịch sử]
      HIST --> DISK[JSON và ảnh JPEG trên máy tính]
      API -->|Lệnh camera và heartbeat| AG
  ```

  Frontend mặc định chạy tại `http://localhost:3000`; backend tại `http://localhost:3001`. Proxy `/api` nối frontend với backend. Node.js quản lý tiến trình Python và trao đổi dữ liệu suy luận qua stdin/stdout.

  ### Phân công từng thành phần

  | Thành phần | Công việc |
  | --- | --- |
  | Frontend | Chọn camera, bật/tắt, bắt đầu/tạm dừng nhận diện, hiển thị hình và bbox, chỉnh ngưỡng, quản lý thông tin cảnh báo |
  | Backend Express | Cung cấp API, quản lý phiên, điều phối AI và bám ảnh, đánh giá hành vi, điều khiển Pi, lưu lịch sử |
  | Python AI | Chạy mô hình người/mặt/đồ vật/tư thế, lấy landmark và bằng chứng hình học |
  | Raspberry Pi | Thu và mã hóa video, phát RTSP, nhận lệnh điều khiển camera và tắt thiết bị |
  | Kho lịch sử | Tự lưu từng lần nhận diện và ảnh mặt; giao diện xem theo ngày, mở từng lần và xóa có xác nhận |

  ## 3. Luồng hoạt động từ lúc mở ứng dụng

  ### Bước 1 — Khởi động

  Chạy `npm start` tại thư mục gốc để mở cả frontend và backend. Backend mở HTTP trước, sau đó nạp AI. Frontend gọi `GET /api/health` để biết trạng thái `loading`, `ok` hoặc `error`; chỉ bắt đầu phiên khi AI sẵn sàng.

  Lần cài đầu dùng `npm run requirement` để chuẩn bị dependency, Python, mô hình và bản build theo các manifest của dự án.

  ### Bước 2 — Chọn nguồn và bật camera

  - **Webcam máy tính:** trình duyệt xin quyền camera và nhận video; không thu âm theo cấu hình mặc định của dự án.
  - **Raspberry Pi:** frontend gửi lệnh qua backend; backend điều khiển camera agent. Video đi từ FFmpeg → MediaMTX → worker đọc RTSP trên máy tính → MJPEG về trình duyệt.

  Camera có thể phát khi chưa nhận diện. Bật camera và bắt đầu AI là hai thao tác riêng.

  ### Bước 3 — Tạo phiên nhận diện

  Frontend tạo phiên bằng `POST /api/sessions`, kèm cấu hình quan sát. Backend quản lý mã theo dõi, trạng thái đồ vật và lịch sử bằng chứng hành vi cho phiên này.

  ### Bước 4 — Bám ảnh và phân tích hành vi chạy theo hai luồng

  **Luồng tọa độ hiển thị:** frontend lấy một ảnh bất biến, gắn `frameId`, mã hóa JPEG với cạnh dài tối đa 640 px rồi gửi tới `POST /api/sessions/:id/track`. Cho phép tối đa bốn yêu cầu đang xử lý. Backend trả tọa độ cùng frame ID; frontend loại phản hồi bị bỏ hoặc cũ hơn khung đã hiển thị.

  `PixelPreview` vẽ ảnh và cập nhật bbox SVG trong cùng lượt xử lý. Nhờ đó bbox thuộc đúng ảnh đang vẽ, thay vì lấy tọa độ từ một kết quả AI chậm rồi chồng lên video mới hơn. Khi nhận diện hoạt động, lớp canvas này nằm trên phần phát camera; hình có độ trễ xử lý riêng, không đồng nghĩa với video gốc hoàn toàn không trễ.

  **Luồng ngữ nghĩa AI:** backend chạy các mô hình để tìm và liên kết người, mặt, đồ vật, tư thế và landmark. Luật hành vi dùng bằng chứng theo thời gian để cập nhật nhãn/màu và cảnh báo. Luồng bám ảnh không phải chờ hoàn tất toàn bộ phân tích hành vi ở mỗi khung.

  Các API phân tích gồm `POST /api/sessions/:id/detect` nhận JPEG và `POST /api/sessions/:id/detect/pi` lấy ảnh Pi hiện có ở backend. API `/track` phục vụ hình học bám ảnh riêng. Việc có nhiều API không có nghĩa frontend luôn gọi tất cả trong mỗi lượt.

  ### Bước 5 — Đánh giá dấu hiệu

  Hệ thống liên kết bằng chứng với từng mã theo dõi và tích lũy qua nhiều mẫu mới. Một ảnh đơn lẻ hoặc cùng số đo bị lặp lại không đủ để xác nhận hành vi kéo dài.

  Từng tín hiệu có thể ở trạng thái thiếu dữ liệu (`unavailable`), chưa thấy dấu hiệu (`clear`), đang tích lũy (`pending`) hoặc đã xác nhận (`confirmed`). Cảnh báo đã xác nhận được giữ mặc định 5 giây để người dùng kịp quan sát.

  Mất mặt không đồng nghĩa mất toàn bộ người: bằng chứng thân, pose và đồ vật vẫn có thể dùng nếu còn hợp lệ. Ngược lại, thiếu khuôn mặt rõ thì không được tự suy ra trạng thái mắt hoặc miệng.

  ### Bước 6 — Hiển thị và ghi nhận

  Giao diện hiển thị camera, khung đánh dấu và danh sách **Cần chú ý**. Mỗi mục có thể chứa mã/tên, dấu hiệu, thời điểm, số lần ghi nhận và ảnh mặt. Ảnh mặt phải lấy từ vùng mặt phù hợp với ảnh phân tích; không lấy vùng thân làm ảnh khuôn mặt. Trường hợp dùng ảnh trước lúc cảnh báo có thông tin đánh dấu riêng.

  Khi bắt đầu nhận diện thành công, frontend tạo một lần lịch sử độc lập với phiên AI kỹ thuật. Bảng **Cần chú ý** có bộ chọn ngày và các block **Lần 1, Lần 2…**; mặc định xem hôm nay và mở lần mới nhất. Cảnh báo tự động đi qua hàng đợi lưu bất đồng bộ. Mỗi người trong một lần chỉ giữ ảnh mặt mới nhất và tổng số đợt cảnh báo, không lưu mọi phản hồi AI. Chi tiết nằm ở mục 6.

  ### Bước 7 — Tạm dừng hoặc kết thúc

  - **Tạm dừng nhận diện:** dừng cập nhật AI/bbox, camera vẫn có thể phát; giữ cùng lần lịch sử khi tiếp tục hoặc kết nối lại AI.
  - **Tắt hoặc đổi camera:** giải phóng nguồn camera, kết thúc lần lịch sử và chuyển các cập nhật cuối sang hàng đợi lưu.
  - **Đặt lại phiên:** kết thúc lần cũ; tạo lần mới nếu đang nhận diện. Lịch sử đã lưu vẫn được giữ.
  - **Tắt Raspberry Pi:** gửi lệnh tắt hệ điều hành qua API điều khiển, là thao tác khác với dừng camera.

  ## 4. Công nghệ đang sử dụng

  Các phiên bản dưới đây lấy từ manifest trong workspace, không phải thông tin phiên bản mới nhất trên Internet.

  | Lớp | Công nghệ | Vai trò |
  | --- | --- | --- |
  | Frontend | React 19.3.1, TypeScript 5.9.3, Vite 8.3.6 | Xây dựng giao diện và ứng dụng trình duyệt |
  | Giao diện | CSS, SVG, Canvas, Motion, Lucide React | Bố cục, hình camera, khung đánh dấu, hiệu ứng và biểu tượng |
  | Xử lý ảnh phía web | ImageBitmap, FrameEncoder, Web Worker | Giữ ảnh theo frame ID và mã hóa khung gửi backend |
  | Backend | Node.js từ 22.19.0, Express 5.3.0, TypeScript | API, phiên nhận diện và quản lý tiến trình |
  | Xử lý ảnh backend | Sharp 0.35.5 | Kiểm tra, chuẩn hóa và lưu ảnh mặt |
  | AI runtime | Python 3.10/3.11, PyTorch 2.5.1, Ultralytics 8.3.230, OpenCV 4.11, MediaPipe 0.10.21, NumPy | Suy luận mô hình và xử lý hình học |
  | Phát hiện người | YOLO11s và ByteTrack | Dò người, liên kết theo thời gian |
  | Đồ vật | YOLO11s ở nhánh CPU, YOLO11m ở nhánh thiết bị khác; kết hợp crop giới hạn | Tìm điện thoại, laptop, sách và cung cấp ngữ cảnh |
  | Tư thế | YOLO11n-pose và nhánh mô hình gục bàn | Lấy bằng chứng thân người, hỗ trợ trường hợp không thấy mặt |
  | Khuôn mặt | SCRFD, YuNet, MediaPipe Face Landmarker | Dò mặt, landmark, hướng đầu và số đo mắt/miệng |
  | Tay | MediaPipe Hand Landmarker | Bằng chứng tay và tương tác với đồ vật |
  | Bám ảnh | Luồng pixel riêng dùng đặc trưng ảnh/Lucas–Kanade; các nhánh VitTrack cho mặt/đồ vật | Cập nhật hình học giữa các lần phân tích AI |
  | Camera Pi | Python agent, FFmpeg, MediaMTX, RTSP, MJPEG, systemd | Thu hình, truyền hình và điều khiển thiết bị |
  | Lịch sử | JSON và JPEG trên filesystem | Lưu ngày/lần nhận diện, cảnh báo và ảnh mặt |
  | Kiểm thử | Vitest, Testing Library, Playwright, bộ kiểm thử Python và examiner | Kiểm tra luật, API, giao diện và mô hình |

  Repo vẫn có mã hoặc dependency cho các nhánh thử nghiệm/cũ như CavT, SAV/SCB và TensorFlow FaceMesh. Sự hiện diện của chúng trong thư mục hoặc manifest không chứng minh chúng đang được bật trong pipeline mặc định.

  ## 5. Mười một dấu hiệu và ngưỡng mặc định

  Nguồn: `backend/src/observation-settings.ts`. Đây là điều kiện thời gian/ngưỡng cấu hình; từng dấu hiệu còn cần bằng chứng hợp lệ và các bộ lọc tương ứng.

  | Dấu hiệu | Ngưỡng mặc định chính |
  | --- | --- |
  | Nhắm mắt kéo dài | 0,8 giây |
  | Cầm điện thoại | 0,4 giây; cần bằng chứng tương tác |
  | Cúi đầu | 0,7 giây; góc cúi tối thiểu 18° |
  | Có thể ngáp | 0,5 giây |
  | Có thể nói chuyện kéo dài | 2,5 giây và ít nhất 4 chu kỳ miệng |
  | Tương tác laptop | 0,7 giây; chỉ thấy laptop chưa đủ |
  | Quay đầu qua lại nhiều lần | 3 lần đổi hướng trong cửa sổ 10 giây |
  | Quay lệch hướng lâu | 2 giây; góc lệch tối thiểu 35°; bỏ qua quay cổ nhẹ |
  | Quay thân sang bên | 2 giây; tỷ lệ vai/thân tối đa 75% so với mốc và bằng chứng hướng phù hợp |
  | Quay sang bên kèm cười | 0,5 giây; điểm cười hai bên tối thiểu 55% và điều kiện quay lệch |
  | Gục đầu/thân trên | 1,5 giây; đối chiếu pose hoặc mô hình gục bàn với người |

  Hướng camera là mốc tham chiếu. Các ngưỡng có thể bật/tắt hoặc chỉnh qua giao diện; cấu hình người dùng đã lưu trên trình duyệt có thể khác bảng mặc định. Backend kiểm tra miền giá trị trước khi áp dụng cho phiên.

  Chuyển động miệng chỉ cung cấp dấu hiệu có thể nói chuyện, không xác nhận âm thanh hay nội dung lời nói. Gục đầu/thân không xác nhận đang ngủ. Điện thoại, sách hoặc laptop cần được đối chiếu với tương tác và hoạt động thực tế của lớp.

  ## 6. Dữ liệu được lưu như thế nào?

  Backend đọc tổng RAM và RAM/commit còn trống để điều chỉnh ngân sách số người trước các bước xử lý theo người. Trần tham chiếu là 20 người trên 8 GB và 40 người trên 16 GB, có thể giảm theo RAM khả dụng. Khi quá giới hạn, giao diện báo “Không đủ RAM để nhận diện.” và vẫn xử lý những người còn trong ngân sách; tự tăng lại khi đủ bộ nhớ. Chi tiết, giới hạn và kiểm tra Pi nằm tại [PI_VA_RAM.md](PI_VA_RAM.md).

  **Trạng thái tích hợp:** `ObservationSession` khởi tạo `DetectionHistory` và nối các cập nhật từ `AttentionCaptures` vào hàng đợi lưu. `HistoryPanel` hiển thị dữ liệu theo ngày/lần, đọc lại ảnh đã lưu và hỗ trợ xóa từng lần hoặc cả ngày có xác nhận. Không cho xóa lần đang ghi hoặc ngày chứa lần đang ghi trong giao diện hiện tại.

  `backend/src/index.ts` khởi tạo `HistoryStore`. Thư mục mặc định là `uploads/detection-history/` tại gốc dự án, tức `D:\_CODE\StudentAttention\uploads\detection-history` trong workspace này; đường dẫn được tính theo vị trí mã backend, không phụ thuộc thư mục chạy lệnh. Có thể đổi bằng biến `HISTORY_DIR`. Thư mục `uploads/` được bỏ qua trong Git.

  ```text
  uploads/detection-history/
    YYYY-MM-DD/
      history.json
      <run-id>/
        <capture-id>.jpg
  ```

  - Ngày được phân loại theo múi giờ `Asia/Ho_Chi_Minh`. Lần chạy qua nửa đêm vẫn thuộc ngày bắt đầu. Số thứ tự tăng riêng trong ngày và không đổi khi xóa lần khác.
  - Mỗi lần nhận diện lưu ID, số thứ tự trong ngày, thời điểm bắt đầu/kết thúc, nguồn `pi`/`webcam` và tên camera.
  - Mỗi mục cảnh báo lưu mã theo dõi, tên hiển thị, nhãn gần nhất, số đợt, thời điểm đầu/cuối và số phiên bản cập nhật. Một cảnh báo kéo dài hoặc đổi dấu hiệu trong cùng đợt không tăng đếm; chỉ tăng sau khi hết cảnh báo rồi tái diễn. Không ghép danh tính giữa các lần.
  - Ảnh mặt được cắt từ ảnh và tọa độ cùng khung, mã hóa bằng worker, tối đa một lần/giây/người. Backend chuẩn hóa JPEG về 160×160 và ghi đè cùng tên ảnh. JSON không nhúng ảnh. Không thấy mặt thì giữ ảnh hợp lệ gần nhất hoặc hiện “Chưa chụp được mặt”; ảnh có trước cảnh báo được ghi chú.
  - Kho lịch sử hỗ trợ xem danh sách ngày, xem các lần trong ngày, xem chi tiết/ảnh, xóa một lần hoặc xóa theo ngày.
  - API lịch sử giới hạn truy cập từ loopback của máy đang chạy backend và kiểm tra Origin nếu được gửi.
  - Việc lưu dùng hàng đợi ghi và thay file JSON qua file tạm. Số phiên bản giúp tránh cập nhật cũ ghi đè mới; ID đã xóa được ghi nhận để yêu cầu gửi muộn không tạo lại lần đã xóa. Xóa ngày giữ JSON tối thiểu chứa bộ đếm và ID đã xóa, đồng thời xóa ảnh tương ứng.
  - Frontend gộp cập nhật mới nhất theo người và tự thử lại khi lỗi; thông báo “Chưa lưu được lịch sử” không dừng camera/AI. Giới hạn 40 ảnh trong bộ nhớ giao diện không cắt các bản ghi đã lưu. Dữ liệu đã lưu tồn tại sau khi tắt camera, đặt lại phiên, tải lại trang hoặc khởi động lại backend.

  Khung phục vụ truyền hình và suy luận vẫn được xử lý trong bộ nhớ. Tính năng lịch sử lưu **ảnh mặt và metadata cảnh báo**; mã đã rà soát không cho thấy chức năng mặc định ghi toàn bộ video camera vào kho lịch sử này.

  ## 7. API chính

  | Nhóm | API tiêu biểu | Kết quả |
  | --- | --- | --- |
  | Trạng thái | `GET /api/health` | AI sẵn sàng hay đang nạp/lỗi, capability và metric nếu có |
  | Cấu hình | `GET /api/observation-settings` | Danh mục dấu hiệu, trường ngưỡng và mặc định |
  | Phiên | `POST /api/sessions`, `DELETE /api/sessions/:id` | Tạo và thu hồi phiên theo dõi |
  | Ngưỡng phiên | `GET`, `PUT /api/sessions/:id/settings` | Đọc/cập nhật cấu hình phiên |
  | Phân tích | `POST /api/sessions/:id/detect` | Tracks, đồ vật, thời gian xử lý |
  | Phân tích Pi | `POST /api/sessions/:id/detect/pi` | Kết quả AI và tuổi khung Pi |
  | Bám ảnh | `POST /api/sessions/:id/track` | Frame ID và tọa độ tương ứng |
  | Camera Pi | `/api/pi/status`, `/api/pi/camera/start`, `/api/pi/camera/stop`, `/api/pi/shutdown` | Trạng thái và điều khiển Pi |
  | Lịch sử | `/api/history/days`, `/api/history/days/:date`, `/api/history/runs` | Tra cứu ngày/lần và tạo lần nhận diện |
  | Chi tiết lịch sử | `/api/history/runs/:id`, `/api/history/runs/:id/captures` | Xem/kết thúc/xóa lần và cập nhật cảnh báo |
  | Ảnh lịch sử | `GET /api/history/runs/:id/captures/:captureId/photo` | Ảnh JPEG đã lưu |

  ## 8. Kết quả hiện tại và mức độ kiểm chứng

  ### Chức năng có trong mã nguồn

  - Có giao diện quan sát với webcam máy tính và nguồn Pi.
  - Có luồng bám ảnh dùng frame ID; ảnh và bbox được cập nhật cùng lượt hiển thị.
  - Có bộ đánh giá 11 dấu hiệu, ngưỡng riêng theo phiên và cơ chế giữ cảnh báo.
  - Có danh sách người cần chú ý và xử lý ảnh mặt.
  - Có API/kho lưu lịch sử bền vững, hàng đợi đồng bộ trong phiên nhận diện và giao diện lịch sử theo ngày/lần.
  - Có quản lý trạng thái AI, phiên nhận diện và điều khiển camera Pi.

  ### Kết quả kiểm chứng đã được tài liệu dự án ghi nhận

  Phần cập nhật ngày 15/11/2026 trong `docs/prepare/TONG_QUAN_CONG_NGHE_VA_LUONG_HOAT_DONG.md` ghi nhận đã chạy 5 clip qua frontend/backend thật, gồm trường hợp thêm 1,2 giây trễ AI: ảnh và bbox khớp frame ID, không lỗi API. Tài liệu trỏ tới chẩn đoán tại `.qa/behavior_full_audit` và video demo `backend/tests/test_results/class_3.mp4`.

  Đây là kết quả được ghi nhận từ lần thử trước, **không phải phép đo chạy lại trong lần viết tài liệu này**. Nó chứng minh khả năng đồng bộ luồng hiển thị trong các tình huống thử đó; chưa chứng minh đúng toàn bộ bbox hoặc 11 loại hành vi.

  Đối chiếu trực tiếp các tệp `pixel-report.json` đang có trong `.qa/behavior_full_audit`:

  | Tình huống | Khung đã hiển thị | FPS ghép hình | Phản hồi AI | P95 xử lý hình học | P95 trình bày |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | `class_3` | 523 | 29,25 | 20 | 24,33 ms | 69,30 ms |
  | `class_4_delay` | 366 | 29,73 | 6 | 19,88 ms | 48,90 ms |
  | `charades_FGRL2` | 922 | 29,91 | 315 | 12,95 ms | 32,80 ms |
  | `charades_3JCEI` | 497 | 24,95 | 210 | 11,49 ms | 28,90 ms |

  Cả bốn báo cáo đều có `complete=true`, `sameFrame=true`, không ghi lỗi API/pixel. P95 là mốc mà 95% mẫu đo không vượt quá. Các metric trên phản ánh phép thử và định nghĩa đo của công cụ, không phải độ trễ từ cảm biến camera thật đến màn hình hay tốc độ được bảo đảm trên mọi máy. `sameFrame` kiểm tra đồng bộ ảnh/tọa độ, không đánh giá bbox có ôm đúng người hoặc nhãn hành vi có đúng hay không.

  ### Kiểm chứng tích hợp lịch sử ngày 15/11/2026

  Bộ kiểm thử frontend đã qua 176 trường hợp; bộ kiểm thử kho lịch sử qua 8 trường hợp, gồm ghi đè JPEG, revision cũ, qua nửa đêm, khởi động lại, xóa và retry. Các bộ kiểm thử backend/Python hiện có cũng đã được chạy trong đợt tích hợp này. `verify-startup.mjs` chạy entry point production với AI thật và kiểm tra tạo lần idempotent, lưu, đọc ảnh, kết thúc, xóa và từ chối tạo lại ID đã xóa.

  `frontend/scripts/check-history.mjs` kiểm tra giao diện React/API với webcam và Pi MJPEG giả lập, worker bám ảnh Python thật và cảnh báo có kiểm soát. Phép thử gồm nhiều người, một ảnh/người, đếm đợt, tạm dừng/tiếp tục, đặt lại, tắt camera, tải lại trang, mở lại kho backend, chọn ngày và xác nhận xóa. Lệnh chạy từ gốc dự án: `npm --prefix backend run build`, sau đó `npm --prefix frontend run test:history`. Báo cáo và ảnh tại `.qa/history/`; phép thử không liên hệ thiết bị thật.

  So sánh tuần tự trước/sau tích hợp trên cùng nguồn `backend/tests/videos/class_3.mp4`, tốc độ phát 1×, frontend build và AI thật:

  | Bản | Khung đã hiển thị | FPS ghép hình | P95 trình bày |
  | --- | ---: | ---: | ---: |
  | Trước | 493 | 27,60 | 159,10 ms |
  | Có lịch sử | 510 | 28,58 | 145,40 ms |

  Cả hai lần đều `complete=true`, `sameFrame=true`, nguồn không đổi và không có lỗi trong báo cáo API/pixel. Bản có lịch sử đã ghi cảnh báo và JPEG xuống đĩa. Phép thử đạt giới hạn FPS giảm không quá 5% và P95 tăng không quá 20 ms; đây là một cặp đo trên máy hiện tại, không phải cam kết tăng tốc. Báo cáo tại `.qa/history/perf-before/pixel-report.json` và `.qa/history/perf-after/pixel-report.json`.

  ### Những kết quả chưa thể kết luận

  - Chưa có căn cứ xác nhận precision/recall cho đủ 11 dấu hiệu trên video lớp học có nhãn đối chứng.
  - Sách/laptop còn có trường hợp nhầm theo ghi nhận trong tài liệu hiện có.
  - Mặt nhỏ, mờ, bị che hoặc thiếu pose phải được coi là thiếu dữ liệu.
  - Con số tối đa 40 người trên giao diện là giới hạn/mục tiêu của ứng dụng, chưa phải cam kết nhận diện đúng 40 học sinh ngoài thực tế.
  - FPS video, tốc độ bám ảnh và số lần suy luận AI mỗi giây là ba đại lượng khác nhau; video mượt không chứng minh AI phân tích đủ mọi thời điểm.
  - ID có thể đổi khi che khuất, giao cắt hoặc tạo phiên mới; số người/số lần trong lịch sử phản ánh mục ghi nhận, chưa phải thống kê danh tính duy nhất xuyên nhiều phiên.

  ## 9. Đọc mã ở đâu khi cần đối chiếu?

  Các đường dẫn sau tính từ thư mục gốc dự án:

  | Nội dung | Tệp/thư mục |
  | --- | --- |
  | Khung ứng dụng | `frontend/src/App.tsx` |
  | Camera và danh sách cảnh báo | `frontend/src/components/ObservationView.tsx`, `AttentionList.tsx`, `HistoryPanel.tsx` |
  | Vòng đời camera/nhận diện | `frontend/src/lib/session.ts` |
  | Bám và đồng bộ frame | `frontend/src/lib/pixel-camera.ts`, `frontend/src/components/PixelPreview.tsx` |
  | Đồng bộ lịch sử | `frontend/src/lib/history.ts` |
  | Khởi động backend | `backend/src/index.ts` |
  | API chính | `backend/src/app.ts` |
  | Phiên và theo dõi | `backend/src/sessions.ts`, `tracker.ts`, `pixel-tracker.ts` |
  | Luật hành vi | `backend/src/attention.ts`, `facial-behavior.ts`, `head-motion.ts`, `posture-behavior.ts`, `object-context.ts` |
  | Ngưỡng hiện tại | `backend/src/observation-settings.ts` |
  | Kho và API lịch sử | `backend/src/history-store.ts`, `history-api.ts` |
  | Mô hình và pipeline Python | `backend/ai/`, `backend/ai/models.json` |
  | Thiết bị Pi | `Raspberry_pi_4/agent.py`, `mediamtx.example.yml`, `systemd/` |

  Tài liệu này ưu tiên mô tả hiện trạng, không suy ra độ chính xác thực nghiệm chỉ từ việc đã có mô hình hoặc luật xử lý.
