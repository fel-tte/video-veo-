package api

// === Request Types ===

type GenerateRequest struct {
	MediaGenerationContext MediaGenContext        `json:"mediaGenerationContext"`
	ClientContext          ClientContext           `json:"clientContext"`
	Requests              []VideoRequest          `json:"requests"`
	UseV2ModelConfig      bool                    `json:"useV2ModelConfig"`
}

type MediaGenContext struct {
	BatchID string `json:"batchId"`
}

type ClientContext struct {
	ProjectID       string           `json:"projectId"`
	Tool            string           `json:"tool"`
	UserPaygateTier string           `json:"userPaygateTier"`
	SessionID       string           `json:"sessionId"`
	RecaptchaContext RecaptchaContext `json:"recaptchaContext"`
}

type RecaptchaContext struct {
	Token           string `json:"token"`
	ApplicationType string `json:"applicationType"`
}

type VideoRequest struct {
	AspectRatio   string                 `json:"aspectRatio"`
	Seed          int                    `json:"seed"`
	TextInput     TextInput              `json:"textInput"`
	VideoModelKey string                 `json:"videoModelKey"`
	Metadata      map[string]interface{} `json:"metadata"`
}

type TextInput struct {
	StructuredPrompt StructuredPrompt `json:"structuredPrompt"`
}

type StructuredPrompt struct {
	Parts []PromptPart `json:"parts"`
}

type PromptPart struct {
	Text string `json:"text"`
}

type StatusRequest struct {
	Media []MediaRef `json:"media"`
}

type MediaRef struct {
	Name      string `json:"name"`
	ProjectID string `json:"projectId"`
}

// === Response Types ===

type GenerateResponse struct {
	Operations       []OperationResult `json:"operations"`
	RemainingCredits int               `json:"remainingCredits"`
	Workflows        []Workflow        `json:"workflows"`
	Media            []MediaResult     `json:"media"`
}

type OperationResult struct {
	Operation OpRef  `json:"operation"`
	SceneID   string `json:"sceneId"`
	Status    string `json:"status"`
}

type OpRef struct {
	Name string `json:"name"`
}

type Workflow struct {
	Name      string           `json:"name"`
	Metadata  WorkflowMetadata `json:"metadata"`
	ProjectID string           `json:"projectId"`
}

type WorkflowMetadata struct {
	DisplayName    string `json:"displayName"`
	CreateTime     string `json:"createTime"`
	PrimaryMediaID string `json:"primaryMediaId"`
	BatchID        string `json:"batchId"`
}

type MediaResult struct {
	Name          string        `json:"name"`
	ProjectID     string        `json:"projectId"`
	WorkflowID    string        `json:"workflowId"`
	MediaMetadata MediaMetadata `json:"mediaMetadata"`
	Video         *VideoData    `json:"video,omitempty"`
}

type MediaMetadata struct {
	CreateTime  string      `json:"createTime"`
	RequestData RequestData `json:"requestData"`
	MediaStatus MediaStatus `json:"mediaStatus"`
	Visibility  string      `json:"visibility"`
}

type RequestData struct {
	VideoGenerationRequestData *VideoGenRequestData `json:"videoGenerationRequestData,omitempty"`
	PromptInputs              []PromptInput         `json:"promptInputs,omitempty"`
}

type VideoGenRequestData struct {
	VideoModelControlInput VideoModelControl `json:"videoModelControlInput"`
}

type VideoModelControl struct {
	VideoModelName    string `json:"videoModelName"`
	VideoGenMode      string `json:"videoGenerationMode"`
	VideoAspectRatio  string `json:"videoAspectRatio"`
}

type PromptInput struct {
	StructuredPrompt StructuredPrompt `json:"structuredPrompt"`
}

type MediaStatus struct {
	MediaGenerationStatus string `json:"mediaGenerationStatus"`
}

type VideoData struct {
	GeneratedVideo GeneratedVideo `json:"generatedVideo"`
	Operation      OpRef          `json:"operation"`
}

type GeneratedVideo struct {
	Seed        int    `json:"seed"`
	Model       string `json:"model"`
	IsLooped    bool   `json:"isLooped"`
	AspectRatio string `json:"aspectRatio"`
}

type StatusResponse struct {
	Media []MediaResult `json:"media"`
}

type CreditsResponse struct {
	Credits         int    `json:"credits"`
	UserPaygateTier string `json:"userPaygateTier"`
	SKU             string `json:"sku"`
	ServiceTier     string `json:"serviceTier"`
}

// === Model Constants ===

const (
	ModelVeo31Fast     = "veo_3_1_t2v_fast_ultra"
	ModelVeo31FastLow  = "veo_3_1_t2v_fast"
	ModelVeo31Quality  = "veo_3_1_t2v_quality"
	ModelVeo2Fast      = "veo_2_t2v_fast"
	ModelVeo2Quality   = "veo_2_t2v_quality"

	AspectLandscape = "VIDEO_ASPECT_RATIO_LANDSCAPE"
	AspectPortrait  = "VIDEO_ASPECT_RATIO_PORTRAIT"

	StatusPending    = "MEDIA_GENERATION_STATUS_PENDING"
	StatusProcessing = "MEDIA_GENERATION_STATUS_PROCESSING"
	StatusCompleted  = "MEDIA_GENERATION_STATUS_SUCCESSFUL" // NOT "COMPLETED" — verified via API testing
	StatusFailed     = "MEDIA_GENERATION_STATUS_FAILED"

	// Media URL types
	MediaURLUnspecified = "MEDIA_URL_TYPE_UNSPECIFIED" // Returns video (works)
	MediaURLThumbnail   = "MEDIA_URL_TYPE_THUMBNAIL"   // Returns thumbnail image (works)
)

// ModelDisplayNames maps internal model keys to display names.
var ModelDisplayNames = map[string]string{
	ModelVeo31Fast:    "Veo 3.1 - Fast (Ultra)",
	ModelVeo31FastLow: "Veo 3.1 - Fast [Unavailable]",
	ModelVeo31Quality: "Veo 3.1 - Quality [Unavailable]",
	ModelVeo2Fast:     "Veo 2 - Fast [Unavailable]",
	ModelVeo2Quality:  "Veo 2 - Quality [Unavailable]",
}

// AvailableModels lists models that actually work (verified via API testing).
var AvailableModels = []string{ModelVeo31Fast}

// ValidPaygateTiers lists accepted paygate tier values.
var ValidPaygateTiers = []string{"PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO", "PAYGATE_TIER_UNSPECIFIED"}
