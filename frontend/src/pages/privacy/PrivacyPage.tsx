import { useState } from "react";
import { Card, Checkbox } from "@heroui/react";
import { isAnalyticsOptedOut, setAnalyticsOptOut } from "@/analytics/client";

/** Card titles render as `h3` by default; the page owns the only `<h1>` (plan R9). */
const asHeading2 = (props: React.JSX.IntrinsicElements["h2"]) => <h2 {...props} />;

/**
 * 資料蒐集說明.
 *
 * Written against what the system actually does, and re-checked whenever an
 * event is added. Two rules govern the wording:
 *
 * - No promise the deployment cannot keep. The app's analytics does not collect
 *   IP addresses; the hosting path (Cloudflare, the reverse proxy) still sees
 *   them, and the page says so rather than claiming 「完全不會留下任何 IP」.
 * - No claim that outruns the code. Every 不蒐集 item below corresponds to a
 *   field that has no column in the analytics schema and no branch in
 *   `analytics/events.ts`.
 */
export function PrivacyPage() {
  const [optedOut, setOptedOut] = useState(isAnalyticsOptedOut);

  return (
    <section className="page" data-page="privacy">
      <div className="page-heading">
        <div>
          <div className="eyebrow">我們收什麼、不收什麼</div>
          <h1>資料蒐集說明</h1>
        </div>
      </div>

      <Card className="data-card">
        <Card.Header>
          <Card.Title render={asHeading2}>你的個人資料留在這台裝置</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <p>
            系所、年級、輔系、雙主修、已修課程、收藏、不感興趣的課程、完整課表與個人偏好，
            都只儲存在你這台裝置的瀏覽器（IndexedDB）裡。這些資料<strong>不會</strong>上傳到伺服器，
            也不會出現在使用統計中。你可以隨時在「資料管理」頁匯出備份或清除全部資料。
          </p>
          <p>
            推薦與衝堂判斷都在你的瀏覽器內完成：伺服器只負責提供課程資料、課程向量，
            以及把你輸入的主題轉成向量，不會收到你的課表或個人設定。
          </p>
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>我們蒐集哪些使用統計</Card.Title>
          <Card.Description>目的只有一個：知道哪些功能有人用、搜尋與推薦好不好用、哪裡會出錯。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <ul className="reasons">
            <li>使用了哪一個頁面、按了哪一個功能按鈕、用了哪一種篩選器（按鈕與篩選器都以程式內部代號記錄，不是畫面上的文字）。</li>
            <li>搜尋的<strong>字數</strong>、結果筆數、等待時間、是否零結果，以及一次搜尋大約修改了幾次。</li>
            <li>推薦結果的課程代碼、排在第幾名、是否被展開查看、是否被加入課表、是否被移除。</li>
            <li>衝堂發生的次數，以及你選擇「仍要加入」「取消」還是「移除課程」。</li>
            <li>API 反應時間與 HTTP 狀態碼、發生錯誤的元件與錯誤代碼。</li>
            <li>瀏覽器種類與主要版本、作業系統、裝置類型（電腦／平板／手機），用來判斷相容性。</li>
          </ul>
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>我們不蒐集什麼</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <ul className="reasons">
            <li>姓名、學號、Email、電話、成績、修課紀錄。</li>
            <li>你的系所、年級、輔系、雙主修，或任何個人設定內容。</li>
            <li>你的完整課表。系統只會記錄「某一門課被加入／被移除」，不會記錄「某個人的課表是什麼」。</li>
            <li><strong>搜尋關鍵字的原文</strong>。目前完全不儲存，只記錄字數。</li>
            <li>永久的使用者編號、裝置編號或瀏覽器指紋（Canvas、WebGL、字型清單、CPU 核心數等一律不讀取）。</li>
            <li>登入權杖、Cookie 內容、完整網址與查詢字串、完整的錯誤內容或請求內容。</li>
          </ul>
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>沒有帳號，也沒有長期追蹤</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <p>
            本系統沒有帳號系統，也沒有建立任何可以跨天辨識你的編號。為了把「看到推薦 → 點開 → 加入課表」
            串成同一次操作，統計事件會帶一個短期的分頁編號與一個單次操作編號：
          </p>
          <ul className="reasons">
            <li>分頁編號存放在 <code>sessionStorage</code>，關閉分頁即失效，並且最多 2 小時、閒置 30 分鐘後自動更換。</li>
            <li>單次操作編號只存在於畫面執行期間，不寫入任何儲存空間。</li>
            <li>這兩個編號在伺服器上保存 7 天後會被清空，之後的紀錄無法再互相關聯。</li>
          </ul>
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>保存多久</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <ul className="reasons">
            <li>一般使用統計：最多 180 天。</li>
            <li>API 效能與錯誤紀錄：最多 90 天。</li>
            <li>分頁編號與操作編號：7 天後清空。</li>
            <li>每日彙總的統計數字（例如「這門課本日被加入幾次」）會長期保留，但其中已經沒有任何可辨識個人的欄位。</li>
            <li>搜尋關鍵字原文：不儲存，因此沒有保存期限。</li>
          </ul>
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>IP 位址與伺服器紀錄</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2">
          <p>
            <strong>本系統的使用統計不會蒐集 IP 位址</strong>：統計事件裡沒有這個欄位，資料庫也沒有這個欄位。
            伺服器只會在記憶體中短暫使用來源位址做流量限制，不寫入磁碟。
          </p>
          <p>
            但這不等於「完全沒有任何 IP 紀錄」。本系統透過 Cloudflare 對外提供服務，
            網路服務商與代理層基於連線與資安需求，仍可能保有他們自己的連線紀錄。
            這部分不在本系統控制範圍內，因此我們不會宣稱完全沒有。
          </p>
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>你可以關閉使用統計</Card.Title>
          <Card.Description>關閉後，這台裝置不會再送出任何統計事件。網站的所有功能都不受影響。</Card.Description>
        </Card.Header>
        <Card.Content>
          <Checkbox
            isSelected={!optedOut}
            onChange={(selected) => {
              setAnalyticsOptOut(!selected);
              setOptedOut(!selected);
            }}
          >
            <Checkbox.Content className="min-h-11">
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              傳送匿名使用統計
            </Checkbox.Content>
          </Checkbox>
          <p className="muted mt-2">
            如果你的瀏覽器已開啟「Do Not Track」，系統會直接遵守，不需要再切換這個選項。
          </p>
        </Card.Content>
      </Card>

      <p className="muted mt-4">
        本說明會隨系統調整而更新。若日後新增蒐集項目或改變保存期限，這一頁會先更新後才生效。
      </p>
    </section>
  );
}
