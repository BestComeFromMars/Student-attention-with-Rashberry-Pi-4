"""Append the measured SCB limits while preserving every existing DOCX entry."""
import json,shutil,zipfile
from pathlib import Path
from xml.dom import minidom

ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'.qa/action-demo'

def main():
    report=ROOT/'docs/Student_Attention_Bao_cao_KHKT_CapNhat.docx';backup=WORK/'report-before-scb.docx'
    marker='CẬP NHẬT SCB LỚP HỌC VÀ CÀI TRONG REPO — 12/11/2026'
    metrics=json.loads((WORK/'scb/validation.json').read_text());stability=json.loads((WORK/'stability-scb.json').read_text())
    paragraphs=[marker,
        'Chỉ dùng dữ liệu lớp học cho demo. Đã loại hai video Charades ra khỏi thư mục action_demo; không dùng chúng để kết luận hiệu quả trên học sinh.',
        'Model đã tải từ kho SCB chính thức: SCB5 YOLOv7 với ba lớp giơ tay, đọc, viết. Đây chưa phải checkpoint SCB3 sáu lớp. Danh mục Baidu có gói 0.671k_university_yolo_Dataset.zip và các gói model YOLOv8; hiện chưa lấy được tệp đầy đủ do link tải dataset không hợp lệ và máy chủ tệp model trả HTTP 403.',
        'Môi trường và dependency mới cài trong backend/.venv; trọng số tại backend/models/classroom-actions; dữ liệu tại backend/tests/datasets/scb5_read_write; cache và tệp tạm mới tại backend/.cache, backend/.pip-cache, backend/.tmp. Không cài thêm vào Python hệ thống, không thay pagefile.',
        'ONNX đã kiểm tra tương đương với checkpoint thật bằng ba đầu vào, gồm ảnh lớp học có nhãn. Xuất graph và kiểm tra chạy nối tiếp ở hai tiến trình để giảm bộ nhớ. Không huấn luyện lại trọng số.',
        'Kết quả trên 32 ảnh validation khóa trước inference: '+ '; '.join(f"{name}: F1 {row['f1Pct']:.2f}%" for name,row in metrics['classes'].items())+'. Đây là kiểm tra ảnh tĩnh mẫu nhỏ, chưa phải độ chính xác video, chưa đủ sáu lớp SCB3 hoặc 15 hành động SAV; không kết luận đạt 85%.',
        f"Thử luồng camera qua HTTP {stability['durationSeconds']:.1f} giây: đỉnh bộ nhớ AI {stability['peakPrivateMB']:.1f} MB, P95 API {stability['p95LatencyMs']} ms, {stability['fullDropoutFrames']} phản hồi mất toàn bộ track và chưa có hành động xác nhận. Nhánh SCB tiếp tục tắt mặc định; sáu dấu hiệu hiện có giữ nguyên. MobileViCLIP trước đó thiếu text projection trong bước chuẩn bị; artifact cũ đã bị chặn và chưa dùng số đo cũ làm kết luận về chất lượng model.",
        'Chi tiết nguồn, lớp, lệnh tái lập và giới hạn: docs/prepare/SCB_LOP_HOC_CAI_DAT_VA_KIEM_CHUNG.md.']
    if not backup.exists():shutil.copy2(report,backup)
    with zipfile.ZipFile(report) as archive:
        original=archive.read('word/document.xml')
        additions=[];original_text=original.decode('utf-8')
        if marker not in original_text:additions.extend(paragraphs)
        candidate_path=WORK/'classroom-candidates/validation.json'
        candidate_marker='ĐỐI CHIẾU MODEL LỚP HỌC NHỎ — 12/11/2026'
        if candidate_path.is_file() and candidate_marker not in original_text:
            candidate=json.loads(candidate_path.read_text())
            additions.extend([candidate_marker,
                'Đã tải và kiểm tra model cộng đồng YOLOv8n từ rukeshsg/AI-Smart-Classroom-Monitoring-System, commit 5ee923f92a6ac04bd3e83566e87567d771b2a8f8. Checkpoint 24.487.143 byte có 3.012.213 tham số và bảy nhãn Fighting, Sleeping, Using Phone, Reading, Writing, Hand Raising, Eating. Tệp và cache nằm trong repo; không chạy source tải bên ngoài, không huấn luyện lại. Đã xuất ONNX và kiểm tra tương đương ba đầu vào.',
                'Chấm ba lớp chung trên cùng 32 ảnh SCB đã khóa: '+ '; '.join(f"{name}: F1 {row['f1Pct']:.2f}%" for name,row in candidate['classes'].items())+f". Trung vị {candidate['medianMs']:.2f} ms/ảnh, P95 {candidate['p95Ms']:.2f} ms, bộ nhớ riêng đỉnh {candidate['peakPrivateMB']:.1f} MB. Bốn lớp chưa có nhãn không được tính đạt. Model không qua kiểm chứng và không tích hợp vào runtime; không dùng các số đo ảnh tĩnh này làm độ chính xác video."])
        if not additions:print('SCB report appendices already present');return
        document=minidom.parseString(original);body=document.getElementsByTagName('w:body')[0]
        section=next((node for node in body.childNodes if node.nodeName=='w:sectPr'),None)
        for text in additions:
            paragraph=document.createElement('w:p');run=document.createElement('w:r');value=document.createElement('w:t')
            value.appendChild(document.createTextNode(text));run.appendChild(value);paragraph.appendChild(run)
            body.insertBefore(paragraph,section) if section is not None else body.appendChild(paragraph)
        temporary=report.with_suffix('.docx.tmp')
        with zipfile.ZipFile(temporary,'w') as output:
            for entry in archive.infolist():output.writestr(entry,document.toxml(encoding='utf-8') if entry.filename=='word/document.xml' else archive.read(entry.filename))
    temporary.replace(report);print('SCB measurements appended; original report retained')

if __name__=='__main__':main()
