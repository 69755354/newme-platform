"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, fmtDubai } from "@/lib/utils";
import { Toaster, toast } from "sonner";
import {
  ArrowLeft,
  FileText,
  DollarSign,
  Calendar,
  User,
  Clock,
  Plus,
  Trash2,
  Download,
  Send,
  CheckCircle,
  XCircle,
  Save,
  Loader2,
} from "lucide-react";

/* ─── Types ─── */
interface QuotationLineItem {
  product_id: string;
  product_name: string;
  description: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

interface Quotation {
  id: string;
  lead_id: string | null;
  quote_no: string | null;
  version: number | null;
  subtotal: number | null;
  discount_rate: number | null;
  discount_amount: number | null;
  tax_rate: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  currency: string | null;
  valid_until: string | null;
  payment_terms: string | null;
  delivery_terms: string | null;
  status: string;
  pdf_url: string | null;
  ppt_url: string | null;
  devices_json: any;
  notes: string | null;
  internal_notes: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
  leads?: {
    id: string;
    customer_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
}

interface Product {
  id: string;
  name: string;
  unit_price: number;
  description: string | null;
}

/* ─── Status config ─── */
const STATUS_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  draft: { color: "text-muted-foreground", bg: "bg-gray-500/10", border: "border-gray-500/20" },
  sent: { color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
  accepted: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  rejected: { color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" },
  expired: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

/* ─── Helpers ─── */
function fmtAED(v: number | null | undefined): string {
  if (v == null) return "—";
  return `AED ${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return fmtDubai(d, { locale: "en-US", year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "—";
  }
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return fmtDubai(d, { locale: "en-US", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

/* ════════════════════════════════════════ */
export default function QuotationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const quotationId = params.id as string;

  const { loading: roleLoading, blocked } = useRequireRole([
    "admin",
    "boss",
    "operator",
    "sales",
  ]);
  const supabase = createClient();
  const { t } = useLanguage();

  /* ─── State ─── */
  const [quotation, setQuotation] = useState<Quotation | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Line items
  const [lineItems, setLineItems] = useState<QuotationLineItem[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<string>("");
  const [addingItem, setAddingItem] = useState(false);

  // Status change
  const [changingStatus, setChangingStatus] = useState(false);

  /* ─── Fetch quotation ─── */
  useEffect(() => {
    if (!quotationId) return;

    async function fetchQuotation() {
      setLoading(true);
      setError(null);

      try {
        const { data, error: err } = await supabase
          .from("quotations")
          .select(
            `*,
            leads(id, customer_name, phone, email)`
          )
          .eq("id", quotationId)
          .single();

        if (err) throw err;
        if (!data) throw new Error("Quotation not found");

        setQuotation(data as Quotation);

        // Parse devices_json into line items
        if (data.devices_json && Array.isArray(data.devices_json)) {
          setLineItems(data.devices_json as QuotationLineItem[]);
        }
      } catch (err: any) {
        console.error("Failed to fetch quotation:", err);
        setError(err.message || t("common.loadFailedRetry"));
      } finally {
        setLoading(false);
      }
    }

    fetchQuotation();
  }, [quotationId, supabase]);

  /* ─── Fetch products ─── */
  useEffect(() => {
    async function fetchProducts() {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, unit_price, description")
        .eq("is_active", true)
        .order("name");

      if (!error && data) {
        setProducts(data as Product[]);
      }
    }

    fetchProducts();
  }, [supabase]);

  /* ─── Add line item ─── */
  const handleAddLineItem = async () => {
    if (!selectedProduct || !quotation) return;

    const product = products.find((p) => p.id === selectedProduct);
    if (!product) return;

    setAddingItem(true);

    try {
      const newItem: QuotationLineItem = {
        product_id: product.id,
        product_name: product.name,
        description: product.description || "",
        quantity: 1,
        unit_price: product.unit_price,
        total_price: product.unit_price,
      };

      const updatedItems = [...lineItems, newItem];
      setLineItems(updatedItems);

      // Recalculate totals
      const subtotal = updatedItems.reduce((sum, item) => sum + item.total_price, 0);
      const discountRate = quotation.discount_rate || 0;
      const discountAmount = subtotal * (discountRate / 100);
      const taxRate = quotation.tax_rate || 5;
      const taxAmount = (subtotal - discountAmount) * (taxRate / 100);
      const totalAmount = subtotal - discountAmount + taxAmount;

      // Update quotation
      const { error: updateErr } = await supabase
        .from("quotations")
        .update({
          devices_json: updatedItems,
          subtotal,
          discount_amount: discountAmount,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", quotation.id);

      if (updateErr) throw updateErr;

      setQuotation({
        ...quotation,
        devices_json: updatedItems,
        subtotal,
        discount_amount: discountAmount,
        tax_amount: taxAmount,
        total_amount: totalAmount,
      });

      toast.success(t("quotations.itemAdded") || "Item added");
      setSelectedProduct("");
    } catch (err: any) {
      console.error("Failed to add item:", err);
      toast.error(err.message || t("common.saveFailedRetry"));
    } finally {
      setAddingItem(false);
    }
  };

  /* ─── Remove line item ─── */
  const handleRemoveLineItem = async (index: number) => {
    if (!quotation) return;

    const updatedItems = lineItems.filter((_, i) => i !== index);
    setLineItems(updatedItems);

    try {
      // Recalculate totals
      const subtotal = updatedItems.reduce((sum, item) => sum + item.total_price, 0);
      const discountRate = quotation.discount_rate || 0;
      const discountAmount = subtotal * (discountRate / 100);
      const taxRate = quotation.tax_rate || 5;
      const taxAmount = (subtotal - discountAmount) * (taxRate / 100);
      const totalAmount = subtotal - discountAmount + taxAmount;

      const { error: updateErr } = await supabase
        .from("quotations")
        .update({
          devices_json: updatedItems,
          subtotal,
          discount_amount: discountAmount,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", quotation.id);

      if (updateErr) throw updateErr;

      setQuotation({
        ...quotation,
        devices_json: updatedItems,
        subtotal,
        discount_amount: discountAmount,
        tax_amount: taxAmount,
        total_amount: totalAmount,
      });

      toast.success(t("quotations.itemRemoved") || "Item removed");
    } catch (err: any) {
      console.error("Failed to remove item:", err);
      toast.error(err.message || t("common.saveFailedRetry"));
    }
  };

  /* ─── Update line item quantity ─── */
  const handleUpdateQuantity = async (index: number, newQuantity: number) => {
    if (!quotation || newQuantity < 1) return;

    const updatedItems = [...lineItems];
    updatedItems[index].quantity = newQuantity;
    updatedItems[index].total_price =
      updatedItems[index].unit_price * newQuantity;
    setLineItems(updatedItems);

    try {
      // Recalculate totals
      const subtotal = updatedItems.reduce((sum, item) => sum + item.total_price, 0);
      const discountRate = quotation.discount_rate || 0;
      const discountAmount = subtotal * (discountRate / 100);
      const taxRate = quotation.tax_rate || 5;
      const taxAmount = (subtotal - discountAmount) * (taxRate / 100);
      const totalAmount = subtotal - discountAmount + taxAmount;

      const { error: updateErr } = await supabase
        .from("quotations")
        .update({
          devices_json: updatedItems,
          subtotal,
          discount_amount: discountAmount,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", quotation.id);

      if (updateErr) throw updateErr;

      setQuotation({
        ...quotation,
        devices_json: updatedItems,
        subtotal,
        discount_amount: discountAmount,
        tax_amount: taxAmount,
        total_amount: totalAmount,
      });
    } catch (err: any) {
      console.error("Failed to update quantity:", err);
      toast.error(err.message || t("common.saveFailedRetry"));
    }
  };

  /* ─── Status change ─── */
  const handleStatusChange = async (newStatus: string) => {
    if (!quotation) return;

    setChangingStatus(true);

    try {
      const updateData: any = {
        status: newStatus,
        updated_at: new Date().toISOString(),
      };

      // Set timestamp based on status
      if (newStatus === "sent" && !quotation.sent_at) {
        updateData.sent_at = new Date().toISOString();
      } else if (newStatus === "accepted" && !quotation.accepted_at) {
        updateData.accepted_at = new Date().toISOString();
      } else if (newStatus === "rejected" && !quotation.rejected_at) {
        updateData.rejected_at = new Date().toISOString();
      }

      const { error: updateErr } = await supabase
        .from("quotations")
        .update(updateData)
        .eq("id", quotation.id);

      if (updateErr) throw updateErr;

      setQuotation({ ...quotation, ...updateData });
      toast.success(
        t("quotations.statusUpdated") || `Status updated to ${STATUS_LABELS[newStatus]}`
      );
    } catch (err: any) {
      console.error("Failed to update status:", err);
      toast.error(err.message || t("common.saveFailedRetry"));
    } finally {
      setChangingStatus(false);
    }
  };

  /* ─── Download PDF ─── */
  const handleDownloadPDF = () => {
    if (!quotation?.pdf_url) return;
    window.open(quotation.pdf_url, "_blank");
  };

  if (roleLoading || blocked) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-copper-500" />
      </div>
    );
  }

  if (error || !quotation) {
    return (
      <ErrorState
        message={error || t("common.loadFailedRetry")}
        onRetry={() => window.location.reload()}
      />
    );
  }

  const statusStyle = STATUS_STYLES[quotation.status] || STATUS_STYLES.draft;
  const customerName = quotation.leads?.customer_name || t("common.unnamed") || "Unnamed";

  return (
    <DashboardScrollContainer className="space-y-6">
      {/* Back button */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (window.location.href = "/quotations")}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t("common.back") || "Back"}
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">
              {quotation.quote_no || "Quotation"}
            </h1>
            <Badge
              className={cn(
                "text-xs px-2 py-0.5 font-medium border",
                statusStyle.color,
                statusStyle.bg,
                statusStyle.border
              )}
            >
              {STATUS_LABELS[quotation.status] || quotation.status}
            </Badge>
            {quotation.version && quotation.version > 1 && (
              <Badge variant="outline" className="text-xs">
                v{quotation.version}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {t("quotations.created") || "Created"} {fmtDateTime(quotation.created_at)}
          </p>
        </div>
      </div>

      {/* ─── Customer & Lead Info ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="w-4 h-4" />
            {t("quotations.customerInfo") || "Customer Information"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.customerName") || "Customer Name"}
              </p>
              <p className="text-sm font-medium">{customerName}</p>
            </div>
            {quotation.leads?.phone && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("quotations.phone") || "Phone"}
                </p>
                <p className="text-sm">{quotation.leads.phone}</p>
              </div>
            )}
            {quotation.leads?.email && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("quotations.email") || "Email"}
                </p>
                <p className="text-sm">{quotation.leads.email}</p>
              </div>
            )}
          </div>
          {quotation.lead_id && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => (window.location.href = `/leads/${quotation.lead_id}`)}
              className="mt-2"
            >
              {t("quotations.viewLead") || "View Lead"}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ─── Quotation Summary ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4" />
            {t("quotations.summary") || "Quotation Summary"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.validUntil") || "Valid Until"}
              </p>
              <p className="text-sm font-medium flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {fmtDate(quotation.valid_until)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.subtotal") || "Subtotal"}
              </p>
              <p className="text-sm font-medium">
                {fmtAED(quotation.subtotal)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.discount") || "Discount"} ({quotation.discount_rate || 0}%)
              </p>
              <p className="text-sm font-medium text-rose-500">
                -{fmtAED(quotation.discount_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.tax") || "Tax"} ({quotation.tax_rate || 5}%)
              </p>
              <p className="text-sm font-medium">
                {fmtAED(quotation.tax_amount)}
              </p>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t">
            <div className="flex items-center justify-between">
              <p className="text-base font-semibold">
                {t("quotations.totalAmount") || "Total Amount"}
              </p>
              <p className="text-xl font-bold text-copper-500">
                {fmtAED(quotation.total_amount)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Line Items ─── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4" />
              {t("quotations.lineItems") || "Line Items"}
            </CardTitle>
            <Badge variant="outline">{lineItems.length} items</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add item */}
          <div className="flex gap-2">
            <Select value={selectedProduct} onValueChange={(v) => setSelectedProduct(v ?? '')}>
              <SelectTrigger className="flex-1">
                <SelectValue
                  placeholder={t("quotations.selectProduct") || "Select product"}
                />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name} - {fmtAED(product.unit_price)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleAddLineItem}
              disabled={!selectedProduct || addingItem}
              size="sm"
            >
              {addingItem ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </Button>
          </div>

          {/* Items list */}
          {lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("quotations.noItems") || "No items added yet"}
            </p>
          ) : (
            <div className="space-y-2">
              {lineItems.map((item, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 p-3 border rounded-lg"
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium">{item.product_name}</p>
                    {item.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) =>
                        handleUpdateQuantity(index, parseInt(e.target.value))
                      }
                      className="w-20 h-8 text-center"
                    />
                    <span className="text-xs text-muted-foreground">
                      × {fmtAED(item.unit_price)}
                    </span>
                    <span className="text-sm font-medium w-24 text-right">
                      {fmtAED(item.total_price)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveLineItem(index)}
                      className="h-8 w-8 p-0 text-rose-500 hover:text-rose-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Notes ─── */}
      {quotation.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("quotations.notes") || "Notes"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{quotation.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* ─── Timeline ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="w-4 h-4" />
            {t("quotations.timeline") || "Timeline"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.createdAt") || "Created At"}
              </p>
              <p className="text-sm">{fmtDateTime(quotation.created_at)}</p>
            </div>
            {quotation.sent_at && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("quotations.sentAt") || "Sent At"}
                </p>
                <p className="text-sm text-blue-400">
                  {fmtDateTime(quotation.sent_at)}
                </p>
              </div>
            )}
            {quotation.accepted_at && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("quotations.acceptedAt") || "Accepted At"}
                </p>
                <p className="text-sm text-emerald-400">
                  {fmtDateTime(quotation.accepted_at)}
                </p>
              </div>
            )}
            {quotation.rejected_at && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("quotations.rejectedAt") || "Rejected At"}
                </p>
                <p className="text-sm text-rose-400">
                  {fmtDateTime(quotation.rejected_at)}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                {t("quotations.lastUpdated") || "Last Updated"}
              </p>
              <p className="text-sm">{fmtDateTime(quotation.updated_at)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Actions ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("quotations.actions") || "Actions"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status change */}
          <div>
            <p className="text-sm font-medium mb-2">
              {t("quotations.changeStatus") || "Change Status"}
            </p>
            <div className="flex flex-wrap gap-2">
              {quotation.status !== "sent" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStatusChange("sent")}
                  disabled={changingStatus}
                  className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                >
                  {changingStatus ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  {t("quotations.markAsSent") || "Mark as Sent"}
                </Button>
              )}
              {quotation.status !== "accepted" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStatusChange("accepted")}
                  disabled={changingStatus}
                  className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                >
                  {changingStatus ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <CheckCircle className="w-4 h-4 mr-2" />
                  )}
                  {t("quotations.markAsAccepted") || "Mark as Accepted"}
                </Button>
              )}
              {quotation.status !== "rejected" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStatusChange("rejected")}
                  disabled={changingStatus}
                  className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10"
                >
                  {changingStatus ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <XCircle className="w-4 h-4 mr-2" />
                  )}
                  {t("quotations.markAsRejected") || "Mark as Rejected"}
                </Button>
              )}
            </div>
          </div>

          {/* Download PDF */}
          {quotation.pdf_url && (
            <div>
              <p className="text-sm font-medium mb-2">
                {t("quotations.documents") || "Documents"}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadPDF}
                className="border-copper-500/30 text-copper-400 hover:bg-copper-500/10"
              >
                <Download className="w-4 h-4 mr-2" />
                {t("quotations.downloadPDF") || "Download PDF"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Toaster position="top-center" richColors />
    </DashboardScrollContainer>
  );
}
